// Tests for the server bootstrap: the confirmation seam over a live session and the per-
// package write gate.
//
// Split out of `index.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/server.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ElicitRequestSchema,
  type CallToolResult,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  createFakeClock,
  createFakeRedactor,
  type MemoryJournal,
} from './core/fakes/index.js';
import {
  createLogger,
  loadSettings,
  type PackageName,
  type PackageSpec,
  type Settings,
  type WriteMode,
  type WriteTier,
} from './core/index.js';
import { defineTool } from './mcp/index.js';
import {
  confirmableWriteArgs,
  createCorePackage,
  executeWrite,
  gateArgs,
} from './tools/index.js';
import {
  buildServer,
  cliLogLevel,
  isStrictFlag,
  isVersionFlag,
  logStartupWarnings,
  resolveSdkVersion,
  versionLine,
  type BuildServerDeps,
  type SdkVersionSources,
} from './index.js';
import {
  ACCESS_TOKEN,
  connect,
  makeHarness,
  parseResult,
  recordingLogger,
} from './testing/harness/server.js';

// ---------------------------------------------------------------------------
// The confirmation seam over a live session (D12) and the per-package write
// gate (D9), seen through a synthetic WRITE package
// ---------------------------------------------------------------------------
//
// Everything below drives a real `tools/call` through the bootstrap's own write
// wiring: `buildServer` builds the confirmer from the live session's elicitation
// capability, memoizes one `WriteGate` per DISTINCT effective write mode, and
// picks the gate per call from `registry.writeModeFor`. None of that is visible
// from a read-only package, so the probe below is a write tool built out of the
// SAME shared authoring helpers a real vertical uses (`confirmableWriteArgs` +
// `gateArgs` + `executeWrite`) — a hand-rolled gate call would test the test.
//
// The properties pinned:
//   (a) an ACCEPTED elicitation authorizes an `irreversible` apply, and the
//       prompt the human sees names the tool and the plan it authorizes;
//   (b) a declined prompt — and an accepted one with the box left unticked —
//       both refuse the write, leaving no `applied` journal record;
//   (c) a client that cannot elicit falls through to the operator-token route
//       (CC-MCP-6), which denies without a token and authorizes with one;
//   (d) the per-package write mode is most-restrictive-wins, and two packages
//       resolving to different modes really do get different gates.

/** The operator token the confirm-token fall-through is authorized with. */
const OPERATOR_TOKEN = 'operator-confirm-token-4d3c2b1a';

/** The `irreversible` probe tool the confirmation tests drive. */
const CONFIRM_TOOL = 'facebook_probe_delete';

/** The two write probes used for the per-package write-mode tests. */
const POSTS_WRITE_TOOL = 'facebook_probe_posts_write';
const MODERATION_WRITE_TOOL = 'facebook_probe_moderation_write';

/** What a {@link writeProbePackage} is stamped out of. */
interface WriteProbeOptions {
  /** The package slot the probe occupies (it must be selectable by name). */
  readonly packageName: PackageName;
  readonly tool: string;
  readonly tier: WriteTier;
  /** The package's declared default; omitted ⇒ the package declares none. */
  readonly writeModeDefault?: WriteMode;
}

/**
 * A package holding ONE write tool that runs a trivial mutation through the
 * gate the bootstrap injected. `perform` only echoes its input: what is under
 * test is which gate ran it, and whether it ran at all.
 *
 * It spreads `confirmableWriteArgs` at every tier so a single factory serves
 * both the `irreversible` confirmation tests and the `reversible` write-mode
 * ones; a real reversible tool would spread the narrower `writeArgs`.
 */
function writeProbePackage(options: WriteProbeOptions): PackageSpec {
  const tool = defineTool({
    name: options.tool,
    title: 'Write probe',
    description: 'Test-only: run one write through the injected write gate.',
    inputSchema: z.object({
      ...confirmableWriteArgs,
      note: z.string().describe('Free text; the planned params this write binds to.'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    writeTier: options.tier,
    handler: (input, ctx) =>
      executeWrite(ctx, {
        tool: options.tool,
        tier: options.tier,
        params: { note: input.note },
        ...gateArgs(input),
        summary: `write the note "${input.note}"`,
        perform: () => Promise.resolve({ note: input.note }),
      }),
  });

  return {
    name: options.packageName,
    title: 'Write probe',
    description: 'Test-only write package injected through the packages seam.',
    tools: [tool],
    enabledByDefault: false,
    ...(options.writeModeDefault !== undefined
      ? { writeModeDefault: options.writeModeDefault }
      : {}),
  };
}

/** Settings selecting the `irreversible` probe (plus always-on `core`). */
function confirmSettings(env: Record<string, string> = {}): Settings {
  const { settings } = loadSettings({
    env: { FB_ACCESS_TOKEN: ACCESS_TOKEN, FB_TOOL_PACKAGES: 'ads', ...env },
    loadEnvFile: false,
  });
  return settings;
}

/** The injected packages for a confirmation test: core + the irreversible probe. */
function confirmPackages(): readonly PackageSpec[] {
  return [
    createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
    writeProbePackage({
      packageName: 'ads',
      tool: CONFIRM_TOOL,
      tier: 'irreversible',
    }),
  ];
}

/** One elicitation request, as the client's handler received it. */
interface RecordedPrompt {
  readonly message: string;
  /** The form schema the server asked the human to fill in (form mode only). */
  readonly requestedSchema?: unknown;
}

/**
 * Connect a client that CAN answer an elicitation prompt, recording every prompt
 * it was shown and answering each through `respond`.
 *
 * The advertised capability is `{ form: {} }` rather than the bare `{}` of the
 * older spec revision: this SDK's server-side `elicitInput` requires the `form`
 * sub-capability, so a bare `{}` never reaches the client at all (it throws
 * inside the SDK, which `createConfirmer` then treats as a failed elicitation).
 */
async function connectEliciting(
  deps: BuildServerDeps,
  respond: (prompt: RecordedPrompt) => ElicitResult,
): Promise<{
  client: Client;
  prompts: readonly RecordedPrompt[];
  close: () => Promise<void>;
}> {
  const server = buildServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: 'facebook-mcp-test', version: '0.0.0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  const prompts: RecordedPrompt[] = [];
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    const params = request.params;
    const prompt: RecordedPrompt = {
      message: params.message,
      ...('requestedSchema' in params ? { requestedSchema: params.requestedSchema } : {}),
    };
    prompts.push(prompt);
    return respond(prompt);
  });
  await client.connect(clientTransport);

  return {
    client,
    prompts,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * Dry-run one write, then apply the plan it returned — both over the SAME
 * session, because the gate's plan store lives for one server lifetime.
 */
async function planThenApply(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ planId: string; applied: CallToolResult }> {
  const preview = parseResult(
    (await client.callTool({ name, arguments: args })) as CallToolResult,
  );
  assert.equal(preview['status'], 'preview', 'the first call must be a dry run');
  const planId = String(preview['planId']);
  const applied = (await client.callTool({
    name,
    arguments: { ...args, apply: true, plan_id: planId },
  })) as CallToolResult;
  return { planId, applied };
}

/** The `applied` records the journal holds (the only proof a mutation ran). */
function appliedEntries(journal: MemoryJournal): readonly { tool: string }[] {
  return journal.entries.filter((entry) => entry.outcome === 'applied');
}

test('an accepted elicitation authorizes an irreversible apply', async () => {
  const { deps, journal } = makeHarness({
    settings: confirmSettings(),
    packages: confirmPackages(),
  });
  const session = await connectEliciting(deps, () => ({
    action: 'accept',
    content: { confirm: true },
  }));

  try {
    const { planId, applied } = await planThenApply(session.client, CONFIRM_TOOL, {
      note: 'remove the spam comment',
    });

    assert.notEqual(applied.isError, true);
    const record = parseResult(applied);
    assert.equal(record['status'], 'applied');
    assert.equal(record['applied'], true);

    // Exactly one prompt: the dry run must never bother a human, only the apply.
    assert.equal(session.prompts.length, 1, 'only the apply may raise a prompt');
    const prompt = session.prompts[0];
    assert.ok(prompt);
    // The human answering this prompt is NOT reading the model transcript, so
    // the text has to identify the action and the plan on its own.
    assert.match(prompt.message, new RegExp(CONFIRM_TOOL));
    assert.match(prompt.message, /irreversible write requires out-of-band confirmation/);
    assert.match(prompt.message, /remove the spam comment/);
    assert.ok(
      prompt.message.includes(`Plan: ${planId}`),
      'the prompt must name the plan it authorizes',
    );
    // The prompt is rendered OUTSIDE the session, by whatever UI the client has;
    // a token riding along with it would hand the secret to that UI.
    assert.ok(
      !prompt.message.includes(ACCESS_TOKEN),
      'the confirmation prompt leaked the access token',
    );

    // One boolean to tick — not "type the tool name back", which a human who
    // cannot see the transcript could not answer.
    const schema = prompt.requestedSchema as {
      required?: readonly string[];
      properties?: Record<string, { type?: string }>;
    };
    assert.deepEqual(schema.required, ['confirm']);
    assert.equal(schema.properties?.['confirm']?.type, 'boolean');
  } finally {
    await session.close();
  }

  const applied = appliedEntries(journal);
  assert.equal(applied.length, 1, 'the confirmed apply must be journaled');
  assert.equal(applied[0]?.tool, CONFIRM_TOOL);
});

test('a declined elicitation refuses the write', async () => {
  const { deps, journal } = makeHarness({
    settings: confirmSettings(),
    packages: confirmPackages(),
  });
  const session = await connectEliciting(deps, () => ({ action: 'decline' }));

  try {
    const { applied } = await planThenApply(session.client, CONFIRM_TOOL, {
      note: 'remove the spam comment',
    });

    assert.equal(applied.isError, true);
    const record = parseResult(applied);
    assert.equal(record['code'], 'confirmation_denied');
    assert.equal(record['tool'], CONFIRM_TOOL);
    assert.equal(record['tier'], 'irreversible');
    // The reported method is the channel actually used (CC-MCP-6) — here the
    // human really was asked, and really said no.
    assert.match(String(record['error']), /\(elicitation\)/);
    assert.equal(session.prompts.length, 1);
  } finally {
    await session.close();
  }

  assert.equal(appliedEntries(journal).length, 0, 'a refused write must not apply');
});

test('a cancelled elicitation refuses the write and says it was cancelled', async () => {
  const { deps, journal } = makeHarness({
    settings: confirmSettings(),
    packages: confirmPackages(),
  });
  // Dismissing the prompt is not consent either; the note names what happened.
  const session = await connectEliciting(deps, () => ({ action: 'cancel' }));

  try {
    const { applied } = await planThenApply(session.client, CONFIRM_TOOL, {
      note: 'remove the spam comment',
    });

    assert.equal(applied.isError, true);
    const record = parseResult(applied);
    assert.equal(record['code'], 'confirmation_denied');
    assert.match(String(record['error']), /cancelled/);
    assert.equal(session.prompts.length, 1);
  } finally {
    await session.close();
  }

  assert.equal(appliedEntries(journal).length, 0, 'a cancelled write must not apply');
});

test('an accepted elicitation with the box unticked still refuses the write', async () => {
  const { deps, journal } = makeHarness({
    settings: confirmSettings(),
    packages: confirmPackages(),
  });
  // `accept` is the client saying "the human answered", NOT "the human agreed":
  // reading the action alone would turn a submitted-but-unticked form into a
  // deletion.
  const session = await connectEliciting(deps, () => ({
    action: 'accept',
    content: { confirm: false },
  }));

  try {
    const { applied } = await planThenApply(session.client, CONFIRM_TOOL, {
      note: 'remove the spam comment',
    });

    assert.equal(applied.isError, true);
    const record = parseResult(applied);
    assert.equal(record['code'], 'confirmation_denied');
    assert.match(String(record['error']), /\(elicitation\)/);
  } finally {
    await session.close();
  }

  assert.equal(appliedEntries(journal).length, 0, 'an unticked box must not apply');
});

test('a client without elicitation is denied when no operator token is configured', async () => {
  const { deps, journal } = makeHarness({
    settings: confirmSettings(),
    packages: confirmPackages(),
  });
  // The default `connect` client advertises no capabilities at all, so
  // `elicitVia` throws and the confirmer falls through to the token route.
  const { client, close } = await connect(deps);

  try {
    const { applied } = await planThenApply(client, CONFIRM_TOOL, {
      note: 'remove the spam comment',
    });

    assert.equal(applied.isError, true);
    const record = parseResult(applied);
    assert.equal(record['code'], 'confirmation_denied');
    // Truthfully `denied`, never `elicitation`: no human was asked anything.
    assert.match(String(record['error']), /\(denied\)/);
  } finally {
    await close();
  }

  assert.equal(
    appliedEntries(journal).length,
    0,
    'an unconfirmable write must never fall through to a silent allow',
  );
});

test('the operator token authorizes an apply the client cannot elicit', async () => {
  const { deps, journal } = makeHarness({
    settings: confirmSettings({ FB_CONFIRM_TOKEN: OPERATOR_TOKEN }),
    packages: confirmPackages(),
  });
  const { client, close } = await connect(deps);

  try {
    // A token that does not match is exactly as good as no token at all.
    const wrong = await planThenApply(client, CONFIRM_TOOL, {
      note: 'remove the wrong comment',
      confirm_token: 'not-the-operator-token',
    });
    assert.equal(wrong.applied.isError, true);
    assert.equal(parseResult(wrong.applied)['code'], 'confirmation_denied');

    // The matching token is the whole out-of-band authorization for this apply.
    const right = await planThenApply(client, CONFIRM_TOOL, {
      note: 'remove the spam comment',
      confirm_token: OPERATOR_TOKEN,
    });
    assert.notEqual(right.applied.isError, true);
    const record = parseResult(right.applied);
    assert.equal(record['status'], 'applied');
    assert.equal(record['applied'], true);
  } finally {
    await close();
  }

  const applied = appliedEntries(journal);
  assert.equal(applied.length, 1);
  assert.equal(applied[0]?.tool, CONFIRM_TOOL);
  // The journal is a durable operator artifact; the token that authorized the
  // write is not part of the record (it is neither a param nor metadata).
  assert.ok(
    !JSON.stringify(journal.entries).includes(OPERATOR_TOKEN),
    'the operator token was journaled',
  );
});

/**
 * Settings selecting BOTH write probes. `mode` is the operator's `FB_WRITE_MODE`;
 * passing `undefined` LEAVES IT UNSET, which is the case where a package's own
 * `writeModeDefault` governs — the distinction the bootstrap turns on.
 */
function writeModeSettings(mode: WriteMode | undefined): Settings {
  const { settings } = loadSettings({
    env: {
      FB_ACCESS_TOKEN: ACCESS_TOKEN,
      FB_TOOL_PACKAGES: 'posts,moderation',
      ...(mode !== undefined ? { FB_WRITE_MODE: mode } : {}),
    },
    loadEnvFile: false,
  });
  return settings;
}

/**
 * Two `reversible` write probes plus core. Neither call below passes `apply`, so
 * the ONLY thing that decides preview-vs-apply is the write mode the bootstrap
 * resolved for that tool's package.
 */
function writeModePackages(
  postsDefault: WriteMode | undefined,
  moderationDefault: WriteMode | undefined,
): readonly PackageSpec[] {
  return [
    createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
    writeProbePackage({
      packageName: 'posts',
      tool: POSTS_WRITE_TOOL,
      tier: 'reversible',
      ...(postsDefault !== undefined ? { writeModeDefault: postsDefault } : {}),
    }),
    writeProbePackage({
      packageName: 'moderation',
      tool: MODERATION_WRITE_TOOL,
      tier: 'reversible',
      ...(moderationDefault !== undefined ? { writeModeDefault: moderationDefault } : {}),
    }),
  ];
}

/** Call a write probe with no gating arguments and return its parsed envelope. */
async function callWriteProbe(
  client: Client,
  name: string,
): Promise<Record<string, unknown>> {
  return parseResult(
    (await client.callTool({
      name,
      arguments: { note: `from ${name}` },
    })) as CallToolResult,
  );
}

test('an explicit FB_WRITE_MODE=plan outranks a package that declares apply', async () => {
  const { deps, journal } = makeHarness({
    settings: writeModeSettings('plan'),
    // `moderation` asks for apply-by-default; `posts` declares nothing.
    packages: writeModePackages(undefined, 'apply'),
  });
  const { client, close } = await connect(deps);

  try {
    for (const tool of [POSTS_WRITE_TOOL, MODERATION_WRITE_TOOL]) {
      const record = await callWriteProbe(client, tool);
      // The kill switch: an operator who TYPED `FB_WRITE_MODE=plan` has spoken
      // about every package, so no package default may re-enable the unattended
      // writes that switch was flipped to stop.
      assert.equal(record['status'], 'preview', `${tool} must stay a dry run`);
      assert.equal(record['applied'], false);
    }
  } finally {
    await close();
  }

  assert.equal(appliedEntries(journal).length, 0, 'the kill switch must hold');
});

test('with FB_WRITE_MODE unset each package runs on its own gate', async () => {
  const { deps, journal } = makeHarness({
    settings: writeModeSettings(undefined),
    // `posts` is plan-first (as the real package is); `moderation` ships
    // apply-by-default so day-to-day hide/unhide does not stack a preview.
    packages: writeModePackages('plan', 'apply'),
  });
  const { client, close } = await connect(deps);

  try {
    const planned = await callWriteProbe(client, POSTS_WRITE_TOOL);
    assert.equal(planned['status'], 'preview', 'a plan-first package must dry-run');

    const performed = await callWriteProbe(client, MODERATION_WRITE_TOOL);
    assert.equal(performed['status'], 'applied');
    assert.equal(performed['applied'], true);
  } finally {
    await close();
  }

  // One gate per DISTINCT effective mode, picked per call: had the bootstrap
  // built a single gate from `settings.writeMode`, neither write would have
  // applied; had it built one from the first tool's package, both would.
  const applied = appliedEntries(journal);
  assert.equal(applied.length, 1);
  assert.equal(applied[0]?.tool, MODERATION_WRITE_TOOL);
});

test('an explicit FB_WRITE_MODE=apply overrides a plan-first package', async () => {
  const { deps, journal } = makeHarness({
    settings: writeModeSettings('apply'),
    packages: writeModePackages('plan', 'apply'),
  });
  const { client, close } = await connect(deps);

  try {
    // The operator opted in deliberately, so the declaration no longer governs.
    // The blast radius is bounded to `reversible` tools: `irreversible`/`spend`
    // ignore the write mode outright and still demand apply + plan_id + confirm.
    for (const tool of [POSTS_WRITE_TOOL, MODERATION_WRITE_TOOL]) {
      const record = await callWriteProbe(client, tool);
      assert.equal(record['status'], 'applied', `${tool} must apply`);
    }
  } finally {
    await close();
  }

  assert.equal(appliedEntries(journal).length, 2);
});

// --- Startup config warnings reach the operator ------------------------------

test('a successful start logs every startup config warning, one WARN each', () => {
  // `assertStartupOk` only throws on errors, and the warnings live inside that
  // thrown text — so on a clean start (the common case) an operator whose
  // FB_PAGE_TOKEN is bound to no Page, or whose FB_APP_SECRET is unset, saw
  // nothing at all. The bootstrap must hand the warnings to the logger.
  const { settings, report } = loadSettings({
    env: { FB_PAGE_TOKEN: 'fake-page-token' },
    loadEnvFile: false,
  });
  assert.ok(report.ok, 'a Page token alone is a valid (if warned) configuration');
  assert.ok(report.warnings.length >= 2, 'the fixture must carry several warnings');
  assert.equal(settings.defaultPageId, undefined);

  const { logger, records } = recordingLogger();
  logStartupWarnings(logger, report);

  const warned = records.filter((r) => r.level === 'warn');
  assert.equal(warned.length, report.warnings.length, 'one WARN per warning, no more');
  assert.ok(
    records.every((r) => r.level === 'warn'),
    'warnings never escalate to error nor demote to info',
  );
  for (const problem of report.warnings) {
    const record = warned.find((r) => r.fields?.['code'] === problem.code);
    assert.ok(record, `warning ${problem.code} must be logged`);
    assert.equal(record.msg, 'startup config warning');
    assert.equal(record.fields?.['message'], problem.message);
    if (problem.field !== undefined)
      assert.equal(record.fields?.['field'], problem.field);
  }
  // The unbound-Page-token diagnostic specifically must be among them.
  assert.ok(warned.some((r) => r.fields?.['code'] === 'page-token-unbound'));
});

test('regression: a warning-free start logs nothing at startup-warning level', () => {
  const { report } = loadSettings({
    env: { FB_SYSTEM_TOKEN: 'fake-system-token', FB_APP_SECRET: 's', FB_PAGE_ID: '100' },
    loadEnvFile: false,
  });
  assert.deepEqual(report.warnings, []);
  const { logger, records } = recordingLogger();
  logStartupWarnings(logger, report);
  assert.deepEqual(records, []);
});

// --- `--version` (G-TOOL-5) ------------------------------------------------

test('isVersionFlag recognises only the version flag and its alias', () => {
  assert.equal(isVersionFlag('--version'), true);
  assert.equal(isVersionFlag('-v'), true);
  // Everything else must fall through to the subcommands and the server start,
  // so a typo can never be answered by silently printing a version and exiting 0.
  for (const arg of [undefined, '', 'version', '--v', '-V', 'doctor', '--verbose']) {
    assert.equal(isVersionFlag(arg), false, `${String(arg)} must not be the flag`);
  }
});

test('cliLogLevel quiets routine info above the doctor and setup-token reports', () => {
  // The report is for a human; a JSON "Resolved active Facebook credential…"
  // line above it was the first thing a newcomer saw.
  for (const command of ['doctor', 'setup-token']) {
    assert.equal(cliLogLevel(command, 'info'), 'warn', command);
    assert.equal(cliLogLevel(command, 'warn'), 'warn', command);
    assert.equal(cliLogLevel(command, 'error'), 'error', command);
    // An explicit debug request is honored: the operator asked for everything.
    assert.equal(cliLogLevel(command, 'debug'), 'debug', command);
  }
  // Server mode keeps the configured level: its stderr JSON stream is a contract.
  for (const command of [undefined, '--stdio', 'serve', 'doctorx']) {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      assert.equal(cliLogLevel(command, level), level, `${String(command)}/${level}`);
    }
  }
});

test('the CLI log level drops the credential info line but keeps warnings', () => {
  const lines: string[] = [];
  const logger = createLogger({
    clock: createFakeClock(0),
    redactor: createFakeRedactor(),
    level: cliLogLevel('doctor', 'info'),
    write: (line) => lines.push(line),
  });
  logger.info('Resolved active Facebook credential for page resolution', {});
  logger.warn('startup config warning', {});
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /"level":"warn"/);
});

test('isStrictFlag reads only the doctor argument list, and only the long form', () => {
  assert.equal(isStrictFlag(['--strict']), true);
  // The flag may sit anywhere after the subcommand.
  assert.equal(isStrictFlag(['--json', '--strict']), true);
  // A near-miss must NOT gate: silently exiting non-zero on a typo is worse than
  // ignoring a flag the operator can see was ignored in the report.
  for (const args of [[], ['strict'], ['-s'], ['--Strict'], ['--strict=true']]) {
    assert.equal(isStrictFlag(args), false, `${JSON.stringify(args)} must not gate`);
  }
});

test('versionLine is greppable and names the server, the runtime and the SDK', () => {
  const line = versionLine('1.2.3', '1.29.0', {
    node: 'v22.23.0',
    platform: 'linux',
    arch: 'x64',
  });

  assert.equal(line, 'facebook-mcp 1.2.3 (node v22.23.0, linux x64, sdk 1.29.0)');
  // The second whitespace-separated field is the bare version, so a release
  // script can read it without parsing the parenthetical.
  assert.equal(line.split(' ')[1], '1.2.3');
  assert.equal(line.includes('\n'), false, 'the version output is one line');
});

/**
 * A fake for the two seams {@link resolveSdkVersion} reads through. `resolved`
 * absent ⇒ `resolve` throws, which is what a package that hides its manifest
 * does; every manifest slot absent ⇒ that read throws, as an absent file does.
 */
function fakeSdkSources(opts: {
  /** What `require.resolve` hands back for `<sdk>/package.json`. */
  readonly resolved?: string;
  /** Content served at `resolved`. */
  readonly stub?: string;
  /** Content served for `<ancestor>/node_modules/<sdk>/package.json`. */
  readonly installed?: string;
  /** Content served for this server's own `package.json`. */
  readonly own?: string;
}): SdkVersionSources {
  const serve = (content: string | undefined, path: string): string => {
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };
  return {
    resolve: (specifier) => {
      if (opts.resolved === undefined) {
        throw new Error(`ERR_PACKAGE_PATH_NOT_EXPORTED: ${specifier}`);
      }
      return opts.resolved;
    },
    readText: (path) => {
      const key = String(path);
      if (key === opts.resolved) return serve(opts.stub, key);
      // The walk asks for a path under `node_modules`; nothing else does.
      return key.includes('node_modules')
        ? serve(opts.installed, key)
        : serve(opts.own, key);
    },
  };
}

test('resolveSdkVersion reads the version off the real installed SDK', () => {
  // Deliberately unfaked: this is the assertion that notices the resolution
  // chain rotting under a dependency bump (a new `exports` map, a different
  // install layout), which no fake can catch.
  assert.match(resolveSdkVersion(), /^\d+\.\d+\.\d+/);
});

test('resolveSdkVersion ignores the versionless dist stub Node resolves to', () => {
  const stubPath = '/app/node_modules/@modelcontextprotocol/sdk/dist/cjs/package.json';
  const version = resolveSdkVersion(
    fakeSdkSources({
      // What `require.resolve` really returns for this SDK: the `./*` exports
      // pattern maps `./package.json` onto `./dist/cjs/package.json`, a stub
      // that declares a module type and nothing else.
      resolved: stubPath,
      stub: '{"type":"commonjs"}',
      installed: '{"version":"9.9.9"}',
    }),
  );
  assert.equal(version, '9.9.9');
});

test('resolveSdkVersion walks up to node_modules when the package hides its manifest', () => {
  const version = resolveSdkVersion(
    fakeSdkSources({
      installed: '{"name":"@modelcontextprotocol/sdk","version":"1.2.3"}',
    }),
  );
  assert.equal(version, '1.2.3');
});

test('resolveSdkVersion falls back to the declared dependency range', () => {
  // The dependencies never installed — the range is not the running version,
  // but it still tells a bug report which SDK the tree asked for.
  const version = resolveSdkVersion(
    fakeSdkSources({ own: '{"dependencies":{"@modelcontextprotocol/sdk":"^1.29.0"}}' }),
  );
  assert.equal(version, '^1.29.0');
});

test('resolveSdkVersion degrades to "unknown" instead of throwing', () => {
  // Every source unreadable, then each shape that is readable but says nothing:
  // a manifest without the dependency, a non-object, a corrupt one, and an
  // installed manifest whose `version` is not a string.
  for (const sources of [
    fakeSdkSources({}),
    fakeSdkSources({ own: '{"dependencies":{}}' }),
    fakeSdkSources({ own: 'null' }),
    fakeSdkSources({ own: 'not json at all' }),
    fakeSdkSources({ installed: '{"version":123}' }),
  ]) {
    assert.equal(resolveSdkVersion(sources), 'unknown');
  }
});
