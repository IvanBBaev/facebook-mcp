// Tests for `createRegistry` (task F11, C5, CC-CFG-3): default vs explicit
// resolution, `core` always-on, deny removal, read-only write-tier dropping,
// deny∩readonly interaction, package stamping, by-name lookup, and wiring faults.
//
// Fake packages are built by DOGFOODING `defineTool`, so Zod stays funnelled
// through the one authoring seam (the registry itself never touches Zod).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { defineTool } from './define.js';
import { createRegistry, RegistryError } from './registry.js';
import type {
  PackageName,
  PackageSpec,
  Settings,
  ToolAnnotations,
  ToolResult,
  ToolSpec,
} from '../core/index.js';

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

function ok(): ToolResult {
  return { content: [{ type: 'text', text: 'ok' }] };
}

function readTool(name: string): ToolSpec {
  return defineTool({
    name,
    description: 'read tool',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
    handler: () => Promise.resolve(ok()),
  });
}

function writeTool(name: string): ToolSpec {
  return defineTool({
    name,
    description: 'write tool',
    inputSchema: z.object({}),
    annotations: WRITE,
    writeTier: 'reversible',
    handler: () => Promise.resolve(ok()),
  });
}

function pkg(
  name: PackageName,
  tools: readonly ToolSpec[],
  enabledByDefault = false,
): PackageSpec {
  return { name, tools, enabledByDefault };
}

// A full set of injected packages. `enabledByDefault` is set to `false` even for
// the default-profile packages ON PURPOSE: the registry must drive the default
// surface from F11's snapshot constant, NOT from this informational flag.
function allPackages(): PackageSpec[] {
  return [
    pkg('core', [readTool('core_whoami')]),
    pkg('reader', [readTool('reader_get')]),
    pkg('posts', [readTool('posts_get'), writeTool('posts_create')]),
    pkg('insights', [readTool('insights_get')]),
    pkg('moderation', [readTool('mod_list'), writeTool('mod_hide')]),
    pkg('messages', [readTool('msg_list'), writeTool('msg_send')]),
    pkg('ads', [readTool('ads_get'), writeTool('ads_spend')]),
  ];
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    profiles: {},
    apiVersion: 'v23.0',
    hosts: {
      graph: 'graph.facebook.com',
      graphVideo: 'graph-video.facebook.com',
      rupload: 'rupload.facebook.com',
    },
    requestTimeoutMs: 30_000,
    hostConcurrency: 4,
    writeMode: 'plan',
    maxResultChars: 25_000,
    transport: 'stdio',
    packagesDeny: [],
    packagesReadonly: [],
    journalPath: '/tmp/journal.ndjson',
    logLevel: 'info',
    ...overrides,
  };
}

const names = (reg: { readonly tools: readonly ToolSpec[] }): string[] =>
  reg.tools.map((t) => t.name);

// ---------------------------------------------------------------------------
// Default resolution (toolPackages undefined) — the snapshot surface, ads excluded
// ---------------------------------------------------------------------------

test('default resolution expands the default profile (ads excluded) despite enabledByDefault=false', () => {
  const reg = createRegistry(allPackages(), makeSettings());
  assert.deepEqual(reg.packageNames, [
    'core',
    'reader',
    'posts',
    'insights',
    'moderation',
    'messages',
  ]);
  assert.deepEqual(names(reg), [
    'core_whoami',
    'reader_get',
    'posts_get',
    'posts_create',
    'insights_get',
    'mod_list',
    'mod_hide',
    'msg_list',
    'msg_send',
  ]);
  // ads never appears in the default surface.
  assert.equal(reg.has('ads_get'), false);
});

test('every resolved tool is stamped with its owning package name', () => {
  const reg = createRegistry(allPackages(), makeSettings());
  const stamp = new Map(reg.tools.map((t) => [t.name, t.package]));
  assert.equal(stamp.get('core_whoami'), 'core');
  assert.equal(stamp.get('posts_create'), 'posts');
  assert.equal(stamp.get('msg_send'), 'messages');
  // No tool escapes stamping.
  for (const tool of reg.tools) {
    assert.equal(typeof tool.package, 'string');
  }
});

// ---------------------------------------------------------------------------
// Explicit selection + `core` always-on
// ---------------------------------------------------------------------------

test('explicit list resolves only those packages, with core forced on', () => {
  const reg = createRegistry(allPackages(), makeSettings({ toolPackages: ['reader'] }));
  assert.deepEqual(reg.packageNames, ['core', 'reader']);
  assert.deepEqual(names(reg), ['core_whoami', 'reader_get']);
});

test('an empty explicit list still yields core (always-on)', () => {
  const reg = createRegistry(allPackages(), makeSettings({ toolPackages: [] }));
  assert.deepEqual(reg.packageNames, ['core']);
  assert.deepEqual(names(reg), ['core_whoami']);
});

test('core survives deny (always-on beats FB_PACKAGES_DENY)', () => {
  const reg = createRegistry(
    allPackages(),
    makeSettings({ toolPackages: ['reader'], packagesDeny: ['core'] }),
  );
  assert.equal(reg.has('core_whoami'), true);
  assert.ok(reg.packageNames.includes('core'));
});

// ---------------------------------------------------------------------------
// Deny removal
// ---------------------------------------------------------------------------

test('deny removes a whole package from the default surface', () => {
  const reg = createRegistry(allPackages(), makeSettings({ packagesDeny: ['posts'] }));
  assert.equal(reg.has('posts_get'), false);
  assert.equal(reg.has('posts_create'), false);
  assert.equal(reg.packageNames.includes('posts'), false);
  // The rest of the default surface is intact.
  assert.equal(reg.has('reader_get'), true);
});

// ---------------------------------------------------------------------------
// Read-only: drop write-tier tools, keep read tools (CC-CFG-3)
// ---------------------------------------------------------------------------

test('readonly drops write-tier tools but keeps read tools of the same package', () => {
  const reg = createRegistry(
    allPackages(),
    makeSettings({ packagesReadonly: ['posts'] }),
  );
  assert.equal(reg.has('posts_get'), true); // read tool kept
  assert.equal(reg.has('posts_create'), false); // write tool dropped
  assert.ok(reg.packageNames.includes('posts')); // package still present
  // Other packages keep their write tools.
  assert.equal(reg.has('msg_send'), true);
});

test('deny wins over readonly when a package is in both sets', () => {
  const reg = createRegistry(
    allPackages(),
    makeSettings({ packagesDeny: ['posts'], packagesReadonly: ['posts', 'messages'] }),
  );
  // posts: denied ⇒ gone entirely (not merely read-only).
  assert.equal(reg.has('posts_get'), false);
  assert.equal(reg.packageNames.includes('posts'), false);
  // messages: only read-only ⇒ read kept, write dropped.
  assert.equal(reg.has('msg_list'), true);
  assert.equal(reg.has('msg_send'), false);
});

// ---------------------------------------------------------------------------
// Lookup surface
// ---------------------------------------------------------------------------

test('get/has resolve resolved tools and reject absent ones', () => {
  const reg = createRegistry(allPackages(), makeSettings({ toolPackages: ['reader'] }));
  const spec = reg.get('reader_get');
  assert.ok(spec);
  assert.equal(spec.name, 'reader_get');
  assert.equal(spec.package, 'reader');
  assert.equal(reg.has('reader_get'), true);
  assert.equal(reg.get('does_not_exist'), undefined);
  assert.equal(reg.has('does_not_exist'), false);
});

// ---------------------------------------------------------------------------
// Selection errors delegate to expandSelection (CC-CFG-3)
// ---------------------------------------------------------------------------

test('an unknown selection name surfaces the valid-names error', () => {
  assert.throws(
    () => createRegistry(allPackages(), makeSettings({ toolPackages: ['nonsense'] })),
    /Unknown tool package\/profile name/,
  );
});

// ---------------------------------------------------------------------------
// Wiring faults — RegistryError
// ---------------------------------------------------------------------------

test('a selected-but-unregistered package throws RegistryError', () => {
  const injected = [
    pkg('core', [readTool('core_whoami')]),
    pkg('reader', [readTool('reader_get')]),
  ];
  assert.throws(
    () => createRegistry(injected, makeSettings({ toolPackages: ['reader', 'posts'] })),
    (err: unknown) => {
      assert.ok(err instanceof RegistryError);
      assert.match(err.message, /selected but not registered/);
      return true;
    },
  );
});

test('a duplicate package name in the injected set throws RegistryError', () => {
  const injected = [
    pkg('core', [readTool('core_whoami')]),
    pkg('core', [readTool('core_dup')]),
  ];
  assert.throws(
    () => createRegistry(injected, makeSettings()),
    (err: unknown) => {
      assert.ok(err instanceof RegistryError);
      assert.match(err.message, /duplicate package name/);
      return true;
    },
  );
});

test('a duplicate tool name across resolved packages throws RegistryError', () => {
  const injected = [
    pkg('core', [readTool('core_whoami')]),
    pkg('reader', [readTool('dup_tool')]),
    pkg('posts', [readTool('dup_tool')]),
  ];
  assert.throws(
    () => createRegistry(injected, makeSettings({ toolPackages: ['reader', 'posts'] })),
    (err: unknown) => {
      assert.ok(err instanceof RegistryError);
      assert.match(err.message, /duplicate tool name/);
      return true;
    },
  );
});
