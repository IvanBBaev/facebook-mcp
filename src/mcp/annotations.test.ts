// Annotation manifest snapshot — the whole tool surface, in one frozen table.
//
// Doc 06 opens by promising that EVERY tool carries the full MCP annotation
// quadruple explicitly. That promise is not stylistic. The MCP spec says the
// hints are advisory and, when an `annotations` object is present, an omitted
// hint takes the spec default rather than "unknown": `destructiveHint` defaults
// to TRUE and `idempotentHint` to FALSE. So a half-filled object does not read
// as silence — it reads as a confident claim, usually the most alarming one, and
// a client that gates on `destructiveHint` will start prompting for a tool that
// only lists comments. The failure mode is silent in both directions.
//
// Per-package tests in `src/tools/*.test.ts` already assert the quadruple for
// the tools they own, and `src/metadata.test.ts` asserts that the registry, the
// README table and `manifest.json` agree on tool NAMES. Neither freezes all four
// booleans for the whole surface in one place, which is what this file does:
//
//   * ANNOTATION_MANIFEST below is a frozen literal — 37 rows, one per tool.
//     Changing a hint anywhere in `src/tools/` fails here until the row is
//     edited too, which is the point: the edit is the review.
//   * The table and the registry must agree in BOTH directions, so a new tool
//     cannot ship without its annotations being looked at, and a deleted tool
//     cannot leave a stale row behind.
//   * The cross-cutting invariants (all four hints present; `openWorldHint`
//     always true; `readOnlyHint` ⇔ no write tier) are asserted over the
//     registry itself, not over the table, so they hold for tools the table has
//     not yet heard of.
//
// The surface is expanded through the real registry (`createRegistry` with the
// `all` profile), never by a hand-rolled package list — package expansion,
// canonical ordering and the read-only posture are exactly the ones production
// runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PACKAGE_NAMES,
  type PackageName,
  type PackageSpec,
  type Settings,
  type ToolSpec,
  type WriteTier,
} from '../core/index.js';
import { DEFAULT_PROFILE_PACKAGES, sortByCanonical } from './packages.js';
import { createRegistry, type ToolRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Loading the packages without breaking the layer rule
// ---------------------------------------------------------------------------

/**
 * `src/mcp` is layer 2 and `src/tools` is layer 3; the ESLint layer rules bar a
 * STATIC import of the tools barrel from this directory, test file or not, and
 * that rule is right — the registry must keep working over injected packages.
 * This file is the one place that genuinely needs the concrete surface, so it
 * loads the barrel through a computed specifier: no production module gains a
 * downward edge, and the dependency stays visible right here rather than hidden
 * behind a lint suppression.
 */
const TOOLS_BARREL = new URL('../tools/index.js', import.meta.url).href;

/**
 * Every `create<X>Package` export is a package factory. `core` takes options;
 * the others ignore the extra argument, so one call shape fits all of them.
 * Discovery is dynamic on purpose (same idiom as `src/metadata.test.ts`): a new
 * package that nobody wires up must fail this file rather than slip past a
 * hand-maintained list.
 */
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
    const spec = factory({ serverVersion: '0.0.0-test', sdkVersion: '0.0.0-test' });
    assert.ok(
      typeof spec.name === 'string' && Array.isArray(spec.tools),
      `${name}() did not return a PackageSpec`,
    );
    specs.push(spec);
  }
  assert.ok(specs.length > 0, 'no package factories found in src/tools/index.ts');
  return specs;
}

const PACKAGES = await loadPackages();

/** Settings fixture (mirrors `registry.test.ts`); only selection fields vary. */
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

/** The full surface: the `all` profile is every package, in canonical order. */
function fullRegistry(overrides: Partial<Settings> = {}): ToolRegistry {
  return createRegistry(PACKAGES, makeSettings({ toolPackages: ['all'], ...overrides }));
}

const REGISTRY = fullRegistry();

// ---------------------------------------------------------------------------
// The frozen manifest
// ---------------------------------------------------------------------------

/**
 * One row per registered tool:
 * `[name, readOnlyHint, destructiveHint, idempotentHint, openWorldHint, writeTier]`.
 * `writeTier` is `undefined` for a read-only tool (the `ToolSpec` contract).
 *
 * Grouped by package in canonical order for reading only — the assertions below
 * compare by name, not by position.
 */
type AnnotationRow = readonly [
  name: string,
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
  writeTier: WriteTier | undefined,
];

const ANNOTATION_MANIFEST: readonly AnnotationRow[] = [
  // package `core` — always on, read-only.
  ['facebook_whoami', true, false, true, true, undefined],
  ['facebook_list_pages', true, false, true, true, undefined],
  ['facebook_get_page', true, false, true, true, undefined],
  ['facebook_usage', true, false, true, true, undefined],

  // package `reader` — read-only.
  ['facebook_list_posts', true, false, true, true, undefined],
  ['facebook_get_post', true, false, true, true, undefined],
  ['facebook_list_reels', true, false, true, true, undefined],
  ['facebook_get_reactions', true, false, true, true, undefined],

  // package `posts` — publishing.
  ['facebook_create_post', false, false, false, true, 'reversible'],
  ['facebook_create_photo_post', false, false, false, true, 'reversible'],
  ['facebook_create_video_post', false, false, false, true, 'reversible'],
  ['facebook_create_reel', false, false, false, true, 'reversible'],
  ['facebook_update_post', false, true, true, true, 'reversible'],
  ['facebook_delete_post', false, true, true, true, 'irreversible'],
  ['facebook_list_scheduled_posts', true, false, true, true, undefined],
  ['facebook_get_video_status', true, false, true, true, undefined],

  // package `insights` — read-only.
  ['facebook_page_insights', true, false, true, true, undefined],
  ['facebook_post_insights', true, false, true, true, undefined],
  ['facebook_reel_insights', true, false, true, true, undefined],

  // package `moderation` — comment triage.
  ['facebook_list_comments', true, false, true, true, undefined],
  ['facebook_get_comment', true, false, true, true, undefined],
  ['facebook_reply_to_comment', false, false, false, true, 'reversible'],
  ['facebook_hide_comment', false, false, true, true, 'reversible'],
  ['facebook_delete_comment', false, true, true, true, 'irreversible'],
  ['facebook_private_reply', false, true, false, true, 'irreversible'],
  ['facebook_block_user', false, false, true, true, 'reversible'],
  ['facebook_unblock_user', false, false, true, true, 'reversible'],

  // package `messages` — Page inbox.
  ['facebook_list_conversations', true, false, true, true, undefined],
  ['facebook_get_conversation', true, false, true, true, undefined],
  ['facebook_send_message', false, true, false, true, 'reversible'],

  // package `ads` — off by default.
  ['facebook_list_campaigns', true, false, true, true, undefined],
  ['facebook_list_adsets', true, false, true, true, undefined],
  ['facebook_list_ads', true, false, true, true, undefined],
  ['facebook_get_ad_object', true, false, true, true, undefined],
  ['facebook_ads_insights', true, false, true, true, undefined],
  ['facebook_ads_report_status', true, false, true, true, undefined],
  ['facebook_update_ad_object', false, true, true, true, 'irreversible'],
];

/** The four hints doc 06 requires every tool to spell out. */
const HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const;

/** Read-only view of a tool's hints that tolerates the object being absent. */
function hintsOf(tool: ToolSpec): Partial<Record<(typeof HINTS)[number], unknown>> {
  return tool.annotations ?? {};
}

// ---------------------------------------------------------------------------
// 1. The table and the registry describe the same set of tools
// ---------------------------------------------------------------------------

test('the frozen manifest and the registry list exactly the same tools', () => {
  const registered = new Set(REGISTRY.tools.map((tool) => tool.name));
  const tabled = new Set(ANNOTATION_MANIFEST.map(([name]) => name));

  assert.equal(
    tabled.size,
    ANNOTATION_MANIFEST.length,
    'ANNOTATION_MANIFEST in this file lists the same tool name twice: one row then ' +
      'shadows the other and a real tool goes unchecked. Remove the duplicate.',
  );

  const missingRows = [...registered].filter((name) => !tabled.has(name)).sort();
  assert.deepEqual(
    missingRows,
    [],
    `these tools are registered but have no row in ANNOTATION_MANIFEST: ` +
      `${missingRows.join(', ')}. Fix THIS FILE, not the tool: add a row stating the ` +
      `four hints and the write tier you intend the tool to advertise. A new tool must ` +
      `have its annotations reviewed here, not only in its own package test.`,
  );

  const staleRows = [...tabled].filter((name) => !registered.has(name)).sort();
  assert.deepEqual(
    staleRows,
    [],
    `ANNOTATION_MANIFEST in this file still has rows for tools the registry no longer ` +
      `exposes: ${staleRows.join(', ')}. Fix THIS FILE: delete those rows. If the tools ` +
      `were meant to survive, the defect is in src/tools/ or in the registry selection.`,
  );
});

// ---------------------------------------------------------------------------
// 2. Completeness — a partial annotations object is worse than none
// ---------------------------------------------------------------------------

test('every registered tool spells out all four annotation hints', () => {
  for (const tool of REGISTRY.tools) {
    const hints = hintsOf(tool);
    assert.ok(
      tool.annotations,
      `${tool.name} (package ${tool.package ?? '?'}) carries no annotations object at ` +
        `all. Every tool is authored through defineTool, which requires one — this spec ` +
        `was built by hand or mutated after the fact.`,
    );
    for (const hint of HINTS) {
      assert.equal(
        typeof hints[hint],
        'boolean',
        `${tool.name} leaves ${hint} undefined. A PARTIAL annotations object is more ` +
          `dangerous than no object at all: because an annotations object IS present, ` +
          `the MCP spec applies its defaults to the missing hint — destructiveHint ` +
          `defaults to true and idempotentHint to false — so the omission does not read ` +
          `as "unknown", it silently asserts something about ${tool.name} that nobody ` +
          `chose. State all four hints explicitly in src/tools/ (doc 06).`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. The quadruple itself, frozen per tool
// ---------------------------------------------------------------------------

test('every tool matches the annotation quadruple and write tier frozen here', () => {
  const specs = new Map(REGISTRY.tools.map((tool) => [tool.name, tool]));

  for (const [
    name,
    readOnlyHint,
    destructiveHint,
    idempotentHint,
    openWorldHint,
    writeTier,
  ] of ANNOTATION_MANIFEST) {
    const spec = specs.get(name);
    assert.ok(spec, `${name} has a row here but the registry does not expose it`);

    // deepEqual (strict, from node:assert/strict) also rejects EXTRA keys, so an
    // unknown hint cannot be smuggled in alongside the four.
    assert.deepEqual(
      spec.annotations,
      { readOnlyHint, destructiveHint, idempotentHint, openWorldHint },
      `${name} annotations drifted from the frozen quadruple. If the new values are ` +
        `intended, update the row in ANNOTATION_MANIFEST too — that edit is the review. ` +
        `If they are not, the regression is in src/tools/${spec.package ?? '?'}.ts.`,
    );
    assert.equal(
      spec.writeTier,
      writeTier,
      `${name} writeTier drifted (frozen: ${String(writeTier)}, actual: ` +
        `${String(spec.writeTier)}). The tier decides whether FB_WRITE_MODE=apply is ` +
        `enough or an explicit plan_id plus confirmation is required, so a change here ` +
        `changes what an operator has to do — update the row deliberately.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Cross-cutting invariants, asserted over the registry
// ---------------------------------------------------------------------------

test('openWorldHint is true for every tool — all of them call a live Graph API', () => {
  const closed = REGISTRY.tools
    .filter((tool) => hintsOf(tool)['openWorldHint'] !== true)
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(
    closed,
    [],
    `these tools claim a closed world: ${closed.join(', ')}. Every tool in this server ` +
      `talks to graph.facebook.com, whose responses change without us doing anything, ` +
      `so openWorldHint must be true — a false value tells a client it may cache or ` +
      `replay the result.`,
  );
});

test('readOnlyHint: true means the tool is not write-gated at all', () => {
  for (const tool of REGISTRY.tools) {
    if (hintsOf(tool)['readOnlyHint'] !== true) continue;
    assert.equal(
      tool.writeTier,
      undefined,
      `${tool.name} advertises readOnlyHint: true but declares writeTier ` +
        `'${String(tool.writeTier)}'. Those cannot both be true: the tier exists ` +
        `precisely because the tool changes state. defineTool rejects this pairing, so ` +
        `the spec was assembled outside it.`,
    );
  }
});

test('every write-gated tool advertises readOnlyHint: false', () => {
  const validTiers: ReadonlySet<string> = new Set([
    'safe',
    'reversible',
    'irreversible',
    'spend',
  ]);
  for (const tool of REGISTRY.tools) {
    if (tool.writeTier === undefined) continue;
    assert.ok(
      validTiers.has(tool.writeTier),
      `${tool.name} declares an unknown writeTier '${String(tool.writeTier)}'; the gate ` +
        `in src/mcp/write-mode.ts only understands ${[...validTiers].join(', ')}.`,
    );
    assert.equal(
      hintsOf(tool)['readOnlyHint'],
      false,
      `${tool.name} is write-gated (tier '${tool.writeTier}') yet does not advertise ` +
        `readOnlyHint: false. A client that trusts readOnlyHint would call it without ` +
        `confirmation, which is exactly what the tier is there to prevent.`,
    );
  }
});

test('the read-only posture drops exactly the tools that are not readOnlyHint', () => {
  // The strongest form of the previous two tests: run the real mechanism.
  // FB_PACKAGES_READONLY drops every tool with a writeTier, so what survives must
  // be precisely the set the manifest marks read-only.
  const readOnlyRegistry = fullRegistry({ packagesReadonly: ['all'] });
  const survivors = readOnlyRegistry.tools.map((tool) => tool.name).sort();
  const expected = ANNOTATION_MANIFEST.filter(([, readOnlyHint]) => readOnlyHint)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(
    survivors,
    expected,
    'FB_PACKAGES_READONLY=all kept a different set of tools than the manifest calls ' +
      'read-only. Either a tool advertises readOnlyHint: true while carrying a write ' +
      'tier (it would be dropped, weakening a documented posture), or a write tool ' +
      'declares no tier and survives a read-only install, which is a safety hole.',
  );
});

// ---------------------------------------------------------------------------
// 5. The counts doc 06 and the README publish
// ---------------------------------------------------------------------------

test('the full surface is 37 tools across 7 packages', () => {
  assert.deepEqual(
    [...REGISTRY.packageNames],
    [...PACKAGE_NAMES],
    'the `all` profile no longer expands to every package in canonical order',
  );
  assert.equal(
    REGISTRY.packageNames.length,
    7,
    'the package count changed; update doc 06, the README and manifest.json together',
  );
  assert.equal(
    REGISTRY.tools.length,
    37,
    'the tool count changed; doc 06, the README table and manifest.json all publish it',
  );
  assert.equal(
    ANNOTATION_MANIFEST.length,
    37,
    'the frozen manifest lost or gained a row',
  );
});

test('the default `core` profile ships 30 tools — everything except `ads`', () => {
  // `toolPackages: undefined` is what an operator who never set FB_TOOL_PACKAGES gets.
  const byDefault = createRegistry(PACKAGES, makeSettings());
  assert.deepEqual(
    [...byDefault.packageNames],
    sortByCanonical([...DEFAULT_PROFILE_PACKAGES] as PackageName[]),
    'the default profile no longer expands to DEFAULT_PROFILE_PACKAGES',
  );
  assert.equal(
    byDefault.tools.length,
    30,
    'the out-of-box tool count changed; the README and doc 06 both quote 30',
  );
  assert.equal(
    byDefault.has('facebook_list_campaigns'),
    false,
    '`ads` leaked into the default surface; it must be opted into explicitly',
  );
  assert.equal(
    REGISTRY.tools.length - byDefault.tools.length,
    7,
    'the `ads` package no longer accounts for the 7-tool gap between all and default',
  );
});

test('the surface splits 23 read / 14 write (10 reversible, 4 irreversible)', () => {
  const read = REGISTRY.tools.filter((tool) => hintsOf(tool)['readOnlyHint'] === true);
  const write = REGISTRY.tools.filter((tool) => tool.writeTier !== undefined);

  assert.equal(read.length, 23, 'the read-only tool count changed (doc 06 quotes 23)');
  assert.equal(write.length, 14, 'the write tool count changed (doc 06 quotes 14)');
  assert.equal(read.length + write.length, REGISTRY.tools.length, 'a tool is neither');

  const byTier: Record<string, number> = {};
  for (const tool of write) {
    const tier = String(tool.writeTier);
    byTier[tier] = (byTier[tier] ?? 0) + 1;
  }
  assert.deepEqual(
    byTier,
    { reversible: 10, irreversible: 4 },
    'the write-tier distribution changed. `spend` and `safe` are deliberately unused ' +
      'today: nothing here charges money, and no write is cheap enough to skip the ' +
      'gate. A new tier in this map is a safety-review event, not a refactor.',
  );
});
