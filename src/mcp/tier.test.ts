// Tests for the single tier declaration (C11, QA-07, D-QA-4): the spec's
// `writeTier` bounds the tier every handler hands the write gate. Covers the
// pure `tierWithinDeclared` rule, the `bindDeclaredTier` wrapper, the binding
// `defineTool` installs, and a registry-wide check over the real tool surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import type {
  PackageSpec,
  ToolAnnotations,
  ToolContext,
  ToolResult,
  WriteTier,
} from '../core/index.js';
import { defineTool, hasDeclaredTierGate } from './define.js';
import {
  bindDeclaredTier,
  tierWithinDeclared,
  WriteGateError,
  type WriteAction,
  type WriteGate,
  type WriteOutcome,
} from './write-mode.js';

const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const TIERS: readonly WriteTier[] = ['safe', 'reversible', 'irreversible', 'spend'];

/** A gate that records every action it is handed and previews nothing real. */
function recordingGate(): { gate: WriteGate; seen: WriteAction[] } {
  const seen: WriteAction[] = [];
  const gate: WriteGate = {
    execute<T = unknown>(action: WriteAction<T>): Promise<WriteOutcome<T>> {
      seen.push(action as WriteAction);
      return Promise.resolve({
        kind: 'preview',
        preview: {
          planId: 'plan-1',
          tool: action.tool,
          tier: action.tier,
          summary: 'recorded',
          warnings: [],
          notPerformedNotice: 'not performed',
          expiresAt: 0,
        },
      } as WriteOutcome<T>);
    },
  };
  return { gate, seen };
}

function action(tier: WriteTier): WriteAction {
  return {
    tool: 'facebook_test_write',
    tier,
    params: {},
    summary: 'test write',
    perform: () => Promise.resolve(undefined),
  };
}

function ok(): ToolResult {
  return { content: [{ type: 'text', text: 'ok' }] };
}

// ---------------------------------------------------------------------------
// The pure rule
// ---------------------------------------------------------------------------

test('tierWithinDeclared allows exactly the same gate class at or below the declaration', () => {
  const allowed: Record<WriteTier, readonly WriteTier[]> = {
    safe: ['safe'],
    reversible: ['safe', 'reversible'],
    irreversible: ['irreversible'],
    spend: ['irreversible', 'spend'],
  };
  for (const declared of TIERS) {
    for (const tier of TIERS) {
      assert.equal(
        tierWithinDeclared(tier, declared),
        allowed[declared].includes(tier),
        `tier ${tier} under declared ${declared}`,
      );
    }
  }
});

test('tierWithinDeclared refuses a tier outside the union on either side', () => {
  const unknown = 'destructive' as unknown as WriteTier;
  for (const tier of TIERS) {
    assert.equal(tierWithinDeclared(unknown, tier), false);
    assert.equal(tierWithinDeclared(tier, unknown), false);
  }
});

// ---------------------------------------------------------------------------
// The gate wrapper
// ---------------------------------------------------------------------------

test('bindDeclaredTier refuses a downgraded tier before the inner gate sees it (mutant M17)', async () => {
  const { gate, seen } = recordingGate();
  const bound = bindDeclaredTier(gate, 'spend');
  await assert.rejects(bound.execute(action('reversible')), (err: unknown) => {
    assert.ok(err instanceof WriteGateError);
    assert.equal(err.code, 'tier_mismatch');
    assert.equal(err.tool, 'facebook_test_write');
    assert.equal(err.tier, 'reversible');
    assert.match(err.message, /declares writeTier "spend"/);
    return true;
  });
  assert.equal(seen.length, 0);
});

test('bindDeclaredTier refuses a tier above the declared worst case', async () => {
  const { gate, seen } = recordingGate();
  await assert.rejects(
    bindDeclaredTier(gate, 'irreversible').execute(action('spend')),
    (err: unknown) => err instanceof WriteGateError && err.code === 'tier_mismatch',
  );
  assert.equal(seen.length, 0);
});

test('bindDeclaredTier forwards an allowed action unchanged', async () => {
  const { gate, seen } = recordingGate();
  const sent = action('irreversible');
  const outcome = await bindDeclaredTier(gate, 'spend').execute(sent);
  assert.equal(outcome.kind, 'preview');
  assert.deepEqual(seen, [sent]);
  assert.equal(seen[0], sent);
});

// ---------------------------------------------------------------------------
// defineTool installs the binding
// ---------------------------------------------------------------------------

function gateCallingTool(declared: WriteTier, handed: WriteTier) {
  return defineTool({
    name: 'facebook_test_write',
    description: 'write tool for the tier binding',
    inputSchema: z.object({}),
    annotations: WRITE,
    writeTier: declared,
    handler: async (_input, ctx) => {
      const gate = (ctx as ToolContext & { readonly writeGate: WriteGate }).writeGate;
      await gate.execute(action(handed));
      return ok();
    },
  });
}

test('defineTool binds the gate of a write tool to its declared tier', async () => {
  const { gate, seen } = recordingGate();
  const ctx = { writeGate: gate } as unknown as ToolContext;

  await assert.rejects(
    gateCallingTool('irreversible', 'reversible').handler({}, ctx),
    (err: unknown) => err instanceof WriteGateError && err.code === 'tier_mismatch',
  );
  assert.equal(seen.length, 0);

  await gateCallingTool('irreversible', 'irreversible').handler({}, ctx);
  assert.equal(seen.length, 1);
});

test('defineTool passes a context without a gate through untouched', async () => {
  const seenCtx: ToolContext[] = [];
  const ctx = { writeGate: null } as unknown as ToolContext;
  const spec = defineTool({
    name: 'facebook_test_write',
    description: 'write tool',
    inputSchema: z.object({}),
    annotations: WRITE,
    writeTier: 'reversible',
    handler: (_input, received) => {
      seenCtx.push(received);
      return Promise.resolve(ok());
    },
  });
  await spec.handler({}, ctx);
  assert.equal(seenCtx[0], ctx);
});

test('defineTool leaves a read-only tool context as it is and marks no tier gate', async () => {
  const { gate } = recordingGate();
  const ctx = { writeGate: gate } as unknown as ToolContext;
  const seenCtx: ToolContext[] = [];
  const spec = defineTool({
    name: 'facebook_test_read',
    description: 'read tool',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
    handler: (_input, received) => {
      seenCtx.push(received);
      return Promise.resolve(ok());
    },
  });
  await spec.handler({}, ctx);
  assert.equal(seenCtx[0], ctx);
  assert.equal(hasDeclaredTierGate(spec), false);
});

test('hasDeclaredTierGate is false for a hand-built write spec', () => {
  const built = gateCallingTool('reversible', 'reversible');
  assert.equal(hasDeclaredTierGate(built), true);
  assert.equal(
    hasDeclaredTierGate({ ...built, handler: () => Promise.resolve(ok()) }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Registry-wide: every real write tool checks its tier against its spec
// ---------------------------------------------------------------------------

/**
 * Loaded through a computed specifier for the same reason as
 * `annotations.test.ts`: `src/mcp` may not import `src/tools` statically.
 */
const TOOLS_BARREL = new URL('../tools/index.js', import.meta.url).href;

async function loadPackages(): Promise<readonly PackageSpec[]> {
  const barrel = (await import(TOOLS_BARREL)) as Record<string, unknown>;
  const specs: PackageSpec[] = [];
  for (const [name, value] of Object.entries(barrel)) {
    if (!/^create[A-Za-z0-9]*Package$/.test(name)) continue;
    if (typeof value !== 'function') continue;
    const factory = value as (opts: {
      serverVersion: string;
      sdkVersion?: string;
    }) => PackageSpec;
    specs.push(factory({ serverVersion: '0.0.0-test', sdkVersion: '0.0.0-test' }));
  }
  return specs;
}

test('every write tool in every package binds its gate to the declared writeTier', async () => {
  const packages = await loadPackages();
  const writes = packages.flatMap((pkg) =>
    pkg.tools.filter((tool) => tool.writeTier !== undefined),
  );
  assert.ok(writes.length > 0, 'no write tools found');
  const unbound = writes.filter((tool) => !hasDeclaredTierGate(tool)).map((t) => t.name);
  assert.deepEqual(unbound, []);
});
