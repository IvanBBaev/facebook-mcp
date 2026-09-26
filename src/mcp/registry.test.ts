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
import { createRegistry, effectiveWriteMode, RegistryError } from './registry.js';
import { PackageSelectionError } from './packages.js';
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

test('`FB_PACKAGES_DENY=all` is a one-token kill switch down to read-only core', () => {
  // Documented in docs/runbooks/kill-switch.md as the fastest in-process stop. It
  // works because deny expands the `all` profile to every package and `core` is
  // then forced back on — so the surface collapses to core's read-only tools
  // without the operator having to enumerate the write packages under pressure,
  // and without FB_TOOL_PACKAGES having to be correct.
  const reg = createRegistry(
    allPackages(),
    makeSettings({ toolPackages: ['all'], packagesDeny: ['all'] }),
  );
  assert.deepEqual(reg.packageNames, ['core']);
  assert.deepEqual(names(reg), ['core_whoami']);
});

test('deny expands profiles, so denying `core` empties the default surface', () => {
  // The trap this pins: `core` is both a package name and a profile name, and
  // `expandSelection` — which deny runs through just like the allow list — lets the
  // PROFILE win. So this does not remove one package, it removes all six; the `core`
  // package then comes back only because it is always-on. An operator reading
  // "packages to exclude" would predict the exact opposite of what happens, which is
  // why README says so explicitly now.
  const reg = createRegistry(allPackages(), makeSettings({ packagesDeny: ['core'] }));
  assert.deepEqual(reg.packageNames, ['core']);
  assert.deepEqual(names(reg), ['core_whoami']);
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

test('readonly drops a tool that declares a write in EITHER of its two signals', () => {
  // `defineTool` cross-checks the two independent read-only signals, so a spec
  // that disagrees with itself cannot come out of it — but `createRegistry`
  // does not consume `defineTool`, it consumes an INJECTED `PackageSpec[]` that
  // it never re-validates. A write tool that forgets `writeTier` (added later,
  // copy-pasted off a read tool, hand-built in a fixture) still announces
  // `readOnlyHint:false` to the client and still mutates.
  //
  // Keying the read-only drop on `writeTier` alone makes FB_PACKAGES_READONLY
  // fail OPEN on exactly that fault: the operator asked for a deployment that
  // cannot write and gets a mutating tool served. A read-only package is a
  // containment control, so it must drop on the UNION of the signals — one
  // missing field may cost a tool, never the guarantee.
  const undertiered: ToolSpec = {
    name: 'posts_delete',
    description: 'write tool whose writeTier was never filled in',
    inputSchema: z.object({}),
    annotations: WRITE,
    handler: () => Promise.resolve(ok()),
  };
  const reg = createRegistry(
    [
      pkg('core', [readTool('core_whoami')]),
      pkg('posts', [readTool('posts_get'), undertiered]),
    ],
    makeSettings({ toolPackages: ['posts'], packagesReadonly: ['posts'] }),
  );
  assert.equal(reg.has('posts_get'), true, 'genuine read tools are still kept');
  assert.equal(
    reg.has('posts_delete'),
    false,
    'a read-only package may not serve a tool that announces itself as a write',
  );
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

// Three environment variables feed expandSelection and every one of them fails
// the server closed. The message is the operator's only signal, and the runbook
// (docs/runbooks/kill-switch.md) sends people to edit FB_PACKAGES_DENY under
// incident pressure — so "which variable" has to be in the text, not inferred.
test('a bad name in FB_TOOL_PACKAGES names FB_TOOL_PACKAGES', () => {
  assert.throws(
    () => createRegistry(allPackages(), makeSettings({ toolPackages: ['nonsense'] })),
    (err: unknown) => {
      assert.ok(err instanceof PackageSelectionError);
      assert.equal(err.source, 'FB_TOOL_PACKAGES');
      assert.match(err.message, /in FB_TOOL_PACKAGES/);
      return true;
    },
  );
});

test('a bad name in FB_PACKAGES_DENY names FB_PACKAGES_DENY, not the allow list', () => {
  assert.throws(
    () =>
      createRegistry(
        allPackages(),
        // The allow list is valid; only the deny list is typo'd. Reporting
        // FB_TOOL_PACKAGES here would send the operator to edit a correct setting.
        makeSettings({ toolPackages: ['all'], packagesDeny: ['reeder'] }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof PackageSelectionError);
      assert.equal(err.source, 'FB_PACKAGES_DENY');
      assert.match(err.message, /in FB_PACKAGES_DENY/);
      assert.doesNotMatch(err.message, /FB_TOOL_PACKAGES/);
      return true;
    },
  );
});

test('a bad name in FB_PACKAGES_READONLY names FB_PACKAGES_READONLY', () => {
  assert.throws(
    () => createRegistry(allPackages(), makeSettings({ packagesReadonly: ['red-only'] })),
    (err: unknown) => {
      assert.ok(err instanceof PackageSelectionError);
      assert.equal(err.source, 'FB_PACKAGES_READONLY');
      assert.match(err.message, /in FB_PACKAGES_READONLY/);
      return true;
    },
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

// ---------------------------------------------------------------------------
// Per-package write mode (task D9): `effectiveWriteMode` + `writeModeFor`
// ---------------------------------------------------------------------------

// Packages that exercise the three shapes of `PackageSpec.writeModeDefault`:
// declared `plan`, declared `apply`, and absent. `pkg` is reused so the ONLY
// difference from the fixtures above is the new field.
function writeModePackages(): PackageSpec[] {
  return [
    pkg('core', [readTool('core_whoami')]),
    // `reader` declares nothing ⇒ it follows `settings.writeMode` verbatim.
    pkg('reader', [readTool('reader_get')]),
    // `posts` is plan-first by declaration (README "Default write mode" column).
    {
      ...pkg('posts', [readTool('posts_get'), writeTool('posts_create')]),
      writeModeDefault: 'plan',
    },
    // `moderation` declares `apply` to avoid confirmation stacking on hide/delete.
    {
      ...pkg('moderation', [readTool('mod_list'), writeTool('mod_hide')]),
      writeModeDefault: 'apply',
    },
  ];
}

const WRITE_MODE_SELECTION = ['reader', 'posts', 'moderation'];

test('effectiveWriteMode: an unset FB_WRITE_MODE lets the package default govern', () => {
  // `globalExplicit` false means the operator said nothing, so `globalMode` is
  // only the compiled-in fallback and the package's own declaration wins.
  assert.equal(effectiveWriteMode('plan', 'apply'), 'apply');
  assert.equal(effectiveWriteMode('plan', 'plan'), 'plan');
  assert.equal(effectiveWriteMode('apply', 'plan'), 'plan');
  assert.equal(effectiveWriteMode('apply', 'apply'), 'apply');
  // No declaration ⇒ the compiled-in default passes through untouched.
  assert.equal(effectiveWriteMode('plan', undefined), 'plan');
  assert.equal(effectiveWriteMode('apply', undefined), 'apply');
});

test('effectiveWriteMode: an explicit FB_WRITE_MODE outranks every package default', () => {
  // THE KILL-SWITCH CASE: an operator who typed `FB_WRITE_MODE=plan` has spoken
  // about every package, so a package shipping `'apply'` cannot re-enable
  // unattended writes. `packageDefault ?? globalMode` would fail right here.
  assert.equal(effectiveWriteMode('plan', 'apply', true), 'plan');
  assert.equal(effectiveWriteMode('plan', 'plan', true), 'plan');
  assert.equal(effectiveWriteMode('plan', undefined, true), 'plan');
  // Symmetrically, an explicit `apply` is a deliberate opt-in and is not undone
  // by a plan-first package. It is bounded: the `irreversible` and `spend` tiers
  // ignore the write mode entirely, so only `reversible` writes are reached.
  assert.equal(effectiveWriteMode('apply', 'plan', true), 'apply');
  assert.equal(effectiveWriteMode('apply', 'apply', true), 'apply');
  assert.equal(effectiveWriteMode('apply', undefined, true), 'apply');
});

test('writeModeFor honours a package default while FB_WRITE_MODE is unset', () => {
  const reg = createRegistry(
    writeModePackages(),
    makeSettings({ writeMode: 'plan', toolPackages: WRITE_MODE_SELECTION }),
  );
  // `moderation` ships `apply` so hide/unhide does not stack a plan preview on
  // every comment (A6 / UX #6); the stamp is per package, not per write tier, so
  // its read tool resolves the same way.
  assert.equal(reg.writeModeFor('mod_hide'), 'apply');
  assert.equal(reg.writeModeFor('mod_list'), 'apply');
  // `posts` declares plan-first, and `reader` declares nothing ⇒ compiled default.
  assert.equal(reg.writeModeFor('posts_create'), 'plan');
  assert.equal(reg.writeModeFor('reader_get'), 'plan');
});

test('writeModeFor: an explicit FB_WRITE_MODE=plan is a kill switch over every package', () => {
  const reg = createRegistry(
    writeModePackages(),
    makeSettings({
      writeMode: 'plan',
      writeModeExplicit: true,
      toolPackages: WRITE_MODE_SELECTION,
    }),
  );
  assert.equal(reg.writeModeFor('mod_hide'), 'plan');
  assert.equal(reg.writeModeFor('mod_list'), 'plan');
  assert.equal(reg.writeModeFor('posts_create'), 'plan');
  assert.equal(reg.writeModeFor('reader_get'), 'plan');
});

test('writeModeFor: an explicit FB_WRITE_MODE=apply overrides a plan-first package', () => {
  const reg = createRegistry(
    writeModePackages(),
    makeSettings({
      writeMode: 'apply',
      writeModeExplicit: true,
      toolPackages: WRITE_MODE_SELECTION,
    }),
  );
  assert.equal(reg.writeModeFor('posts_create'), 'apply');
  assert.equal(reg.writeModeFor('reader_get'), 'apply');
  assert.equal(reg.writeModeFor('mod_hide'), 'apply');
});

test('writeModeFor falls back to settings.writeMode for an unknown tool name', () => {
  const planReg = createRegistry(
    writeModePackages(),
    makeSettings({ writeMode: 'plan', toolPackages: WRITE_MODE_SELECTION }),
  );
  assert.equal(planReg.has('does_not_exist'), false);
  assert.equal(planReg.writeModeFor('does_not_exist'), 'plan');

  const applyReg = createRegistry(
    writeModePackages(),
    makeSettings({ writeMode: 'apply', toolPackages: WRITE_MODE_SELECTION }),
  );
  // Falls back to the GLOBAL mode — never to a package default it cannot know.
  assert.equal(applyReg.writeModeFor('does_not_exist'), 'apply');
});

test('get returns the stamped spec for a known name and undefined for an unknown one', () => {
  const injected = writeModePackages();
  const reg = createRegistry(
    injected,
    makeSettings({ writeMode: 'apply', toolPackages: WRITE_MODE_SELECTION }),
  );

  const spec = reg.get('mod_hide');
  assert.ok(spec);
  assert.equal(spec.name, 'mod_hide');
  assert.equal(spec.package, 'moderation'); // stamped by the owning package
  assert.equal(reg.has('mod_hide'), true);

  // The stamp is applied to a COPY: the injected spec is left untouched.
  const injectedSpec = injected
    .flatMap((p) => p.tools)
    .find((t) => t.name === 'mod_hide');
  assert.ok(injectedSpec);
  assert.notEqual(spec, injectedSpec);
  assert.equal(injectedSpec.package, undefined);

  assert.equal(reg.get('mod_unhide'), undefined);
  assert.equal(reg.has('mod_unhide'), false);
});

// ---------------------------------------------------------------------------
// `ads` is off unless it is NAMED — the whole-surface sweep
// ---------------------------------------------------------------------------

// The `ads` package can spend money, so "off by default" is not a preference,
// it is the security boundary of this server (doc 06). One happy-path assertion
// does not settle that: `ads` is INJECTED into every registry, so the question
// is not whether the default list mentions it but whether ANY combination of the
// three selection knobs can put it back. This sweeps the product of every
// selection that does not name `ads`, every deny list, and every read-only list
// — including the token forms that a careless `expandSelection` would fold into
// something else (case, padding, duplicates, an empty segment) — and demands
// that `ads` stay absent from `packageNames`, from `tools`, and from `get`/`has`.
const ADS_TOOLS = ['ads_get', 'ads_spend'] as const;

// Selections that never name `ads` or `all`. `undefined` is the deployed default.
const ADS_FREE_SELECTIONS: readonly (readonly string[] | undefined)[] = [
  undefined,
  [],
  [''],
  ['   '],
  ['core'],
  ['CORE'],
  ['  core  '],
  ['core', 'core'],
  ['core', ''],
  ['reader'],
  ['publisher'],
  ['moderator'],
  ['core', 'reader', 'posts', 'insights', 'moderation', 'messages'],
];

// Deny / read-only accept the same token grammar, so an operator token that
// resolved sloppily here would be just as dangerous: `core` is BOTH a package
// and a profile, and `all` names the ads-bearing profile.
const KNOB_LISTS: readonly (readonly string[])[] = [
  [],
  ['core'],
  ['all'],
  ['posts'],
  ['reader'],
  ['moderation', 'messages'],
  ['ADS'],
  ['  ads  '],
];

test('ads never appears unless the selection names it — full knob sweep', () => {
  for (const toolPackages of ADS_FREE_SELECTIONS) {
    for (const packagesDeny of KNOB_LISTS) {
      for (const packagesReadonly of KNOB_LISTS) {
        const where = `selection=${JSON.stringify(toolPackages)} deny=${JSON.stringify(
          packagesDeny,
        )} readonly=${JSON.stringify(packagesReadonly)}`;
        const reg = createRegistry(
          allPackages(),
          makeSettings({
            ...(toolPackages !== undefined ? { toolPackages } : {}),
            packagesDeny,
            packagesReadonly,
          }),
        );
        assert.equal(reg.packageNames.includes('ads'), false, where);
        for (const tool of ADS_TOOLS) {
          assert.equal(reg.has(tool), false, `${where} has(${tool})`);
          assert.equal(reg.get(tool), undefined, `${where} get(${tool})`);
        }
        assert.equal(
          names(reg).some((n) => n.startsWith('ads_')),
          false,
          where,
        );
      }
    }
  }
});

test('ads comes back on ONLY when a token names the package or the all profile', () => {
  for (const token of ['ads', 'ADS', '  ads  ', 'all']) {
    const reg = createRegistry(allPackages(), makeSettings({ toolPackages: [token] }));
    assert.equal(reg.packageNames.includes('ads'), true, token);
    assert.equal(reg.has('ads_spend'), true, token);
  }
  // And deny still beats an explicit selection, so the kill switch is real.
  const denied = createRegistry(
    allPackages(),
    makeSettings({ toolPackages: ['all'], packagesDeny: ['ads'] }),
  );
  assert.equal(denied.packageNames.includes('ads'), false);
  assert.equal(denied.has('ads_get'), false);
});

test('a duplicate tool name is caught even when read-only drops one of the twins', () => {
  // `posts` owns the write-tier twin, `reader` the read-only one. Without
  // read-only this is the wiring fault the test above pins. Naming `posts` in
  // FB_PACKAGES_READONLY deletes the write twin BEFORE the collision check, so
  // a survivors-only check would start clean and silently serve `reader`'s
  // tool under a name two packages claim — a packaging fault that shows up in
  // some deployments and not others is the one shape it must never take.
  const injected = [
    pkg('core', [readTool('core_whoami')]),
    pkg('posts', [writeTool('dup_tool')]),
    pkg('reader', [readTool('dup_tool')]),
  ];
  assert.throws(
    () =>
      createRegistry(
        injected,
        makeSettings({
          toolPackages: ['posts', 'reader'],
          packagesReadonly: ['posts'],
        }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof RegistryError);
      assert.match(err.message, /duplicate tool name 'dup_tool'/);
      return true;
    },
  );
});

test('a duplicate tool name is caught even when one twin sits in an unselected package', () => {
  // `ads` is off by default, so a survivors-only (or selected-only) check lets
  // the default install boot clean over a packaging fault that crashes the very
  // first deployment to enable `ads` — the fault must not depend on config.
  const injected = [
    pkg('core', [readTool('core_whoami')]),
    pkg('posts', [readTool('dup_tool')]),
    pkg('ads', [readTool('dup_tool')]),
  ];
  assert.throws(
    () => createRegistry(injected, makeSettings({ toolPackages: ['posts'] })),
    (err: unknown) => {
      assert.ok(err instanceof RegistryError);
      assert.match(err.message, /duplicate tool name 'dup_tool'/);
      return true;
    },
  );
});

test('a duplicate tool name is caught even when FB_PACKAGES_DENY removes one twin', () => {
  const injected = [
    pkg('core', [readTool('core_whoami')]),
    pkg('posts', [readTool('dup_tool')]),
    pkg('reader', [readTool('dup_tool')]),
  ];
  assert.throws(
    () =>
      createRegistry(
        injected,
        makeSettings({ toolPackages: ['posts', 'reader'], packagesDeny: ['reader'] }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof RegistryError);
      assert.match(err.message, /duplicate tool name 'dup_tool'/);
      return true;
    },
  );
});

test('a duplicate tool name error names BOTH packages that claim it', () => {
  const injected = [
    pkg('core', [readTool('core_whoami')]),
    pkg('reader', [readTool('dup_tool')]),
    pkg('posts', [readTool('dup_tool')]),
  ];
  assert.throws(
    () => createRegistry(injected, makeSettings({ toolPackages: ['reader', 'posts'] })),
    (err: unknown) => {
      assert.ok(err instanceof RegistryError);
      assert.match(err.message, /'posts'/);
      assert.match(err.message, /'reader'/);
      return true;
    },
  );
});
