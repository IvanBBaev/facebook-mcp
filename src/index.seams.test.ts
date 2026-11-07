// Tests for the server bootstrap: the per-call log line, the upload-progress seam and the
// doctor probe seams.
//
// Split out of `index.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/server.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolResultSchema,
  type CallToolResult,
  type Progress,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  createFakeClock,
  createFakeFbRequest,
  createFakeRedactor,
  fbOk,
  type FakeFbRequest,
} from './core/fakes/index.js';
import {
  createLogger,
  createRedactor,
  loadSettings,
  type PackageSpec,
  type ProgressUpdate,
  type Redactor,
} from './core/index.js';
import { defineTool, type MetricProbeContext } from './mcp/index.js';
import { createCorePackage } from './tools/index.js';
import {
  adAccountProbe,
  buildServer,
  metricProbe,
  type BuildServerDeps,
} from './index.js';
import {
  ACCESS_TOKEN,
  type LogRecord,
  READ_ONLY_ANNOTATIONS,
  SECRET_PAGE_TOKEN,
  connect,
  makeHarness,
  parseResult,
  probePages,
  probeSettings,
  recordingLogger,
  textResult,
} from './testing/harness/server.js';

// ---------------------------------------------------------------------------
// (f) The per-call log line — `ToolSpec.logFields` (04 §"Log hygiene")
// ---------------------------------------------------------------------------
//
// The allowlist is a SECURITY control, so it is pinned from the outside, on the
// wire, rather than by unit-testing the projection helper: what matters is what
// a real `tools/call` puts in front of the logger. Four properties are load
// bearing and each gets its own test —
//
//   * only allowlisted keys appear, and the un-allowlisted sibling never does;
//   * a spec with no allowlist logs NOTHING (no default key set);
//   * every logged value goes through the redactor at the dispatch site;
//   * a non-scalar is reduced to its shape, never its content;
//
// plus the two the placement decision rests on: the line exists even when the
// call is rejected, and it lands on stderr, never on the stdio JSON-RPC channel.

/** The `msg` the bootstrap stamps on its one per-call line. */
const TOOL_CALL_MSG = 'tool call';

/** The probe whose spec allowlists three of its four arguments. */
const LOG_TOOL = 'facebook_probe_logged';

/** The probe that declares no allowlist at all — the 35-of-36 case. */
const QUIET_TOOL = 'facebook_probe_quiet';

/**
 * A probe package (again in the `ads` slot) holding the two specs the log tests
 * contrast: one with an allowlist, one without. `payload` is typed `unknown` on
 * purpose — the allowlist may name an argument whose value is not a scalar, and
 * that is precisely the case the projection has to refuse to serialize.
 */
function logProbePackage(): PackageSpec {
  const logged = defineTool({
    name: LOG_TOOL,
    description: 'Test-only: three of these four arguments are safe to log.',
    inputSchema: z.object({
      page_id: z.string().optional().describe('Allowlisted, and a string.'),
      limit: z.number().optional().describe('Allowlisted, and a non-string scalar.'),
      payload: z.unknown().optional().describe('Allowlisted, but any shape at all.'),
      note: z.string().optional().describe('NOT allowlisted; must never be logged.'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    logFields: ['page_id', 'limit', 'payload'],
    handler: () => Promise.resolve(textResult({ ok: true })),
  });

  const quiet = defineTool({
    name: QUIET_TOOL,
    description: 'Test-only: the same argument, with no allowlist declared.',
    inputSchema: z.object({
      page_id: z
        .string()
        .optional()
        .describe('Never logged: the spec allowlists nothing.'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: () => Promise.resolve(textResult({ ok: true })),
  });

  return {
    name: 'ads',
    title: 'Log probe',
    description: 'Test-only package for the per-call log line.',
    tools: [logged, quiet],
    enabledByDefault: false,
  };
}

/** The injected package array for a log-probe-backed server. */
function logProbePackages(): readonly PackageSpec[] {
  return [
    createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
    logProbePackage(),
  ];
}

/**
 * Drive one call against a log-probe server and hand back both the result and
 * everything the bootstrap logged. `redactor` is injectable because one test
 * needs the REAL redactor (the fake omits the defensive pattern scan).
 */
async function callLogProbe(
  name: string,
  args: Record<string, unknown>,
  redactor?: Redactor,
): Promise<{ readonly result: CallToolResult; readonly records: readonly LogRecord[] }> {
  const { logger, records } = recordingLogger();
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: logProbePackages(),
    logger,
    ...(redactor !== undefined ? { redactor } : {}),
  });
  const { client, close } = await connect(deps);
  try {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { result, records };
  } finally {
    await close();
  }
}

/** The single per-call line, asserted to exist exactly once. */
function onlyCallLine(records: readonly LogRecord[]): LogRecord {
  const lines = records.filter((r) => r.msg === TOOL_CALL_MSG);
  assert.equal(lines.length, 1, `expected exactly one ${TOOL_CALL_MSG} line`);
  const line = lines[0];
  assert.ok(line);
  return line;
}

test('a tool call logs the allowlisted arguments and nothing else', async () => {
  const { records } = await callLogProbe(LOG_TOOL, {
    page_id: '1234567890',
    limit: 7,
    note: 'free-text the operator never reviewed for hygiene',
  });

  // Exactly one line for the whole call, at `info` — the default level, so the
  // control is visible in a default install rather than only under FB_LOG_LEVEL.
  assert.equal(records.length, 1);
  const line = onlyCallLine(records);
  assert.equal(line.level, 'info');
  // The tool name sits at the top level and the arguments nest under `args`, so
  // an argument called `tool` can never displace the name of the tool.
  assert.deepEqual(line.fields, {
    tool: LOG_TOOL,
    args: { page_id: '1234567890', limit: 7 },
  });
  // `note` is an argument the caller DID send; it is absent because the spec
  // does not name it, which is the whole point of an allowlist.
  assert.ok(!JSON.stringify(line.fields).includes('free-text'));
});

test('a tool with no logFields allowlist logs nothing about the call', async () => {
  const { result, records } = await callLogProbe(QUIET_TOOL, { page_id: '1234567890' });

  assert.notEqual(result.isError, true);
  // Not "logs less" — logs NOTHING. An allowlist nobody wrote is not permission
  // to fall back to a default key set, and never to the argument object whole.
  assert.deepEqual(records, []);
});

test('an allowlisted value is redacted before it reaches the log', async () => {
  // The REAL redactor, because both of its strategies matter here: the user
  // token is a registered VALUE, while the Page token is one the process never
  // held and only the defensive pattern scan can catch.
  const { records } = await callLogProbe(
    LOG_TOOL,
    { page_id: `page-of-${ACCESS_TOKEN}`, payload: SECRET_PAGE_TOKEN },
    createRedactor({ secrets: [ACCESS_TOKEN] }),
  );

  const line = onlyCallLine(records);
  const rendered = JSON.stringify(line.fields);
  assert.ok(!rendered.includes(ACCESS_TOKEN), 'the access token reached the log');
  assert.ok(!rendered.includes(SECRET_PAGE_TOKEN), 'the Page token reached the log');
  assert.deepEqual(line.fields, {
    tool: LOG_TOOL,
    args: { page_id: 'page-of-[REDACTED]', payload: '[REDACTED]' },
  });
});

test('a non-scalar allowlisted argument is logged as a type tag, not its content', async () => {
  // An author reviews a KEY, not the arbitrary tree a caller can hang under it,
  // and the line is written before the strict parse — so the runtime shape of a
  // value is whatever the client sent. Anything but a scalar logs its shape.
  const cases: readonly (readonly [unknown, string])[] = [
    [{ token: SECRET_PAGE_TOKEN }, '[object]'],
    [[SECRET_PAGE_TOKEN], '[array]'],
    [null, '[null]'],
  ];

  for (const [value, tag] of cases) {
    const { records } = await callLogProbe(LOG_TOOL, { payload: value });
    const line = onlyCallLine(records);
    assert.deepEqual(line.fields, { tool: LOG_TOOL, args: { payload: tag } });
    assert.ok(
      !JSON.stringify(line.fields).includes('EAA'),
      `a ${tag} argument leaked its content into the log`,
    );
  }
});

test('the log line is written before the handler, so a rejected call still leaves a record', async () => {
  // `limit` must be a number: this call dies in the strict parse inside the
  // spec handler. A line emitted only on success would be missing for exactly
  // the calls worth diagnosing, so the record must exist anyway — carrying the
  // RAW argument, because validation has not run yet.
  const { result, records } = await callLogProbe(LOG_TOOL, { limit: 'not-a-number' });

  assert.equal(result.isError, true);
  assert.deepEqual(onlyCallLine(records).fields, {
    tool: LOG_TOOL,
    args: { limit: 'not-a-number' },
  });
});

test('the per-call log line lands on stderr, never on the stdout channel (CC-CFG-1)', async () => {
  // The other tests inject a recording logger, which proves what the bootstrap
  // hands over but not where it goes. This one runs the REAL logger with its
  // real default sink: on stdio, stdout is the JSON-RPC channel, so a log line
  // that reaches it corrupts the protocol.
  const marker = '1234567890-stdout-purity';
  const logger = createLogger({
    clock: createFakeClock(1_000),
    redactor: createFakeRedactor(),
    level: 'info',
  });
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: logProbePackages(),
    logger,
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  try {
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk: unknown): boolean => {
      stderrChunks.push(String(chunk));
      return true;
    };
    const { client, close } = await connect(deps);
    try {
      await client.callTool({ name: LOG_TOOL, arguments: { page_id: marker } });
    } finally {
      await close();
    }
  } finally {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
    // The capture window spans an await, so the runner's own output can land in
    // it; replay both streams rather than swallowing a failure report.
    for (const chunk of stdoutChunks) realStdout(chunk);
    for (const chunk of stderrChunks) realStderr(chunk);
  }

  assert.ok(
    stderrChunks.some((chunk) => chunk.includes(marker)),
    'the per-call line never reached stderr',
  );
  assert.ok(
    !stdoutChunks.some((chunk) => chunk.includes(marker)),
    'the per-call line corrupted the stdout JSON-RPC channel',
  );
});

// ---------------------------------------------------------------------------
// The upload-progress seam (CC-MCP-1)
// ---------------------------------------------------------------------------
//
// `ToolContext.reportProgress` is the only channel a long upload has to say it
// is still alive, and the bootstrap owns BOTH ends of it: the caller's
// `_meta.progressToken` arrives on the SDK `extra`, and the matching
// `notifications/progress` frames leave through that same request's notification
// sender. Neither end is visible from a tool's own tests (which inject a fake
// reporter), so all three properties are pinned here on the raw wire, through a
// probe tool that does nothing but report:
//
//   * a call that supplied a token gets frames addressed with THAT token;
//   * a call that supplied none gets no reporter and no frames at all;
//   * a notification that cannot be delivered never fails the tool call.

/** The tool name of the progress probe. */
const PROGRESS_TOOL = 'facebook_probe_progress';

/**
 * The updates the probe pushes, in order. The three shapes are deliberate: a
 * full triple, one without a message, and a bare counter with no total (the
 * legal shape for an upload whose size is not known up front) — the optional
 * members must ride along only when present, never as explicit nulls.
 */
const PROBE_UPDATES: readonly ProgressUpdate[] = [
  { progress: 0, total: 3, message: 'uploading chunk 1/3' },
  { progress: 2, total: 3 },
  { progress: 3 },
];

/** An opaque, caller-chosen progress token; the spec allows a string or a number. */
const PROGRESS_TOKEN = 'probe-progress-token-7c3a';

/** A package holding one tool that forwards {@link PROBE_UPDATES} and reports back. */
function progressProbePackage(): PackageSpec {
  const tool = defineTool({
    name: PROGRESS_TOOL,
    title: 'Progress probe',
    description: 'Test-only: push a fixed progress sequence through the ToolContext.',
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: (_input, ctx) => {
      // Exactly how a real upload reports: optional-call, fire and forget.
      for (const update of PROBE_UPDATES) ctx.reportProgress?.(update);
      return Promise.resolve(
        textResult({ hasReporter: ctx.reportProgress !== undefined }),
      );
    },
  });

  return {
    name: 'ads',
    title: 'Progress probe',
    description: 'Test-only package injected through the packages seam.',
    tools: [tool],
    enabledByDefault: false,
  };
}

/** Core plus the progress probe, which occupies the selectable `ads` slot. */
function progressPackages(): readonly PackageSpec[] {
  return [
    createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
    progressProbePackage(),
  ];
}

/** One frame as it left the server transport, read structurally. */
interface WireFrame {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

/**
 * Connect to a progress-probe server, recording every raw frame the SERVER
 * emits — the only place the progress token is observable, since the SDK's
 * client-side dispatcher strips it before handing the update to `onprogress`.
 *
 * `failProgress` makes the transport reject exactly the progress frames. That is
 * the honest way to reproduce the client that closed its stream mid-upload, and
 * the only way to observe that a doomed notification cannot fail the call it
 * belongs to.
 */
async function connectProgress(
  deps: BuildServerDeps,
  failProgress = false,
): Promise<{
  client: Client;
  /** Every server→client frame, in order. */
  readonly frames: readonly WireFrame[];
  close: () => Promise<void>;
}> {
  const server = buildServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const frames: WireFrame[] = [];
  const deliver = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    const frame = message as WireFrame;
    frames.push(frame);
    if (failProgress && frame.method === 'notifications/progress') {
      throw new Error('the client stream is gone');
    }
    await deliver(message, options);
  };

  await server.connect(serverTransport);
  const client = new Client({ name: 'facebook-mcp-test', version: '0.0.0' });
  // A caller-chosen token is unknown to the SDK's own progress bookkeeping, so
  // its dispatcher reports one as a protocol error on `onerror`. That is the
  // client's business, not the server's; swallow it to keep the run quiet.
  client.onerror = () => undefined;
  await client.connect(clientTransport);

  return {
    client,
    frames,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The `notifications/progress` frames the server emitted, in order. */
function progressFrames(
  frames: readonly WireFrame[],
): readonly Record<string, unknown>[] {
  return frames
    .filter((frame) => frame.method === 'notifications/progress')
    .map((frame) => frame.params ?? {});
}

/** Drive one `tools/call` carrying an explicit, caller-chosen progress token. */
async function callWithProgressToken(
  client: Client,
  token: string,
): Promise<CallToolResult> {
  return await client.request(
    {
      method: 'tools/call',
      params: { name: PROGRESS_TOOL, arguments: {}, _meta: { progressToken: token } },
    },
    CallToolResultSchema,
  );
}

test('a progress token turns tool progress into notifications carrying that token', async () => {
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: progressPackages(),
  });
  const session = await connectProgress(deps);

  try {
    const result = await callWithProgressToken(session.client, PROGRESS_TOKEN);

    assert.notEqual(result.isError, true);
    // The reporter must be present, or the tool silently uploads in the dark.
    assert.equal(parseResult(result)['hasReporter'], true);

    // Every update reached the wire, in order, addressed with the caller's own
    // token — an unaddressed (or differently addressed) frame is undeliverable.
    assert.deepEqual(progressFrames(session.frames), [
      {
        progressToken: PROGRESS_TOKEN,
        progress: 0,
        total: 3,
        message: 'uploading chunk 1/3',
      },
      { progressToken: PROGRESS_TOKEN, progress: 2, total: 3 },
      { progressToken: PROGRESS_TOKEN, progress: 3 },
    ]);
  } finally {
    await session.close();
  }
});

test('an SDK client that asks for progress receives the updates it subscribed to', async () => {
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: progressPackages(),
  });
  const session = await connectProgress(deps);

  try {
    // The other half of the contract: a stock SDK client mints its own token
    // via `onprogress`, so this is the path a real MCP host actually takes.
    const seen: Progress[] = [];
    await session.client.callTool(
      { name: PROGRESS_TOOL, arguments: {} },
      CallToolResultSchema,
      { onprogress: (update) => seen.push(update) },
    );

    assert.deepEqual(seen, [...PROBE_UPDATES]);
  } finally {
    await session.close();
  }
});

test('a call without a progress token gets no reporter and emits no notification', async () => {
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: progressPackages(),
  });
  const session = await connectProgress(deps);

  try {
    const result = (await session.client.callTool({
      name: PROGRESS_TOOL,
      arguments: {},
    })) as CallToolResult;

    assert.notEqual(result.isError, true);
    // Absent, not a no-op stub: consumers branch on `reportProgress !== undefined`
    // to decide whether to wire an upload's `onProgress` at all.
    assert.equal(parseResult(result)['hasReporter'], false);
    // A frame with no token is undeliverable and would be reported by the client
    // as a protocol error, so none may be emitted.
    assert.deepEqual(progressFrames(session.frames), []);
  } finally {
    await session.close();
  }
});

test('a notification that cannot be delivered never fails the tool call', async () => {
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: progressPackages(),
  });
  const session = await connectProgress(deps, true);

  try {
    const result = await callWithProgressToken(session.client, PROGRESS_TOKEN);

    // Progress is best-effort: a publish that succeeded must not be reported as
    // a failure because the client stopped listening to the commentary.
    assert.notEqual(result.isError, true);
    assert.equal(parseResult(result)['hasReporter'], true);
    // All three sends were attempted and all three were rejected by the
    // transport; the rejections are swallowed, never left unhandled.
    assert.equal(progressFrames(session.frames).length, PROBE_UPDATES.length);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// Doctor probe seams (V02 metric probe, CC-ADS-6 ad-account probe)
// ---------------------------------------------------------------------------
//
// `mcp/doctor.ts` deliberately owns no api imports, so both probes are built
// here in the bootstrap and injected. They are exported for exactly this: the
// classification is the whole value of the seam, and it is invisible from the
// doctor's own tests (which inject stubs). Everything below runs against fakes.

/** A probe context over the given fake Graph transport. */
function probeContext(
  fb: FakeFbRequest,
  env: Record<string, string> = {},
  signal?: AbortSignal,
): {
  ctx: MetricProbeContext;
} {
  const { settings } = loadSettings({
    env: { FB_ACCESS_TOKEN: ACCESS_TOKEN, ...env },
    loadEnvFile: false,
  });
  return {
    ctx: {
      fbRequest: fb.fn,
      settings,
      clock: createFakeClock(1_760_000_000_000),
      ...(signal !== undefined ? { signal } : {}),
    },
  };
}

/** One Graph insights entry with `points` data points. */
function insightsEntry(name: string, points: number): Record<string, unknown> {
  return {
    name,
    period: 'day',
    values: Array.from({ length: points }, (_, i) => ({
      value: 10 + i,
      end_time: `2026-07-0${String(i + 1)}T07:00:00+0000`,
    })),
  };
}

test('metricProbe reports available when the Page answers insights', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (req) => req.path === '/1010/insights',
    fbOk({
      data: [insightsEntry('page_media_view', 2), insightsEntry('page_follows', 2)],
    }),
  );
  const pages = probePages();

  const result = await metricProbe(pages)(probeContext(fb).ctx);

  assert.equal(result.available, true);
  assert.match(result.summary, /Page 1010 answers insights/);
  assert.match(result.summary, /page_media_view/);
  assert.equal(result.details?.['pageId'], '1010');
  // The probe must use the resolved PAGE token, not the user token — Page
  // insights are readable only with a Page token carrying ANALYZE.
  assert.equal(fb.calls[0]?.token, SECRET_PAGE_TOKEN);
  // Aggregate mode: totals only, so the result carries no row series at all.
  assert.equal(fb.calls.length, 1, 'the probe must cost exactly one Graph call');
});

test('metricProbe blames the eligibility floor when Graph answers with no data', async () => {
  const fb = createFakeFbRequest();
  // Graph accepted both names and returned entries — with zero data points.
  fb.on(
    (req) => req.path === '/1010/insights',
    fbOk({
      data: [insightsEntry('page_media_view', 0), insightsEntry('page_follows', 0)],
    }),
  );

  const result = await metricProbe(probePages())(probeContext(fb).ctx);

  assert.equal(result.available, false);
  // The two indistinguishable causes must BOTH be named, or the operator fixes
  // the wrong one: a Page under the floor, or a token missing the scope/task.
  assert.match(result.summary, /eligibility floor/);
  assert.match(result.summary, /read_insights/);
  assert.match(result.summary, /ANALYZE/);
  assert.deepEqual(result.details?.['empty'], ['page_media_view', 'page_follows']);
});

test('metricProbe blames the metric names when Graph returns no entry at all', async () => {
  const fb = createFakeFbRequest();
  fb.on((req) => req.path === '/1010/insights', fbOk({ data: [] }));

  const result = await metricProbe(probePages())(probeContext(fb).ctx);

  assert.equal(result.available, false);
  // An absent entry is a version problem, NOT a Page problem — saying "your
  // Page has no reach" here would send the operator chasing a ghost.
  assert.match(result.summary, /not valid for the pinned API version/);
  assert.equal((result.details?.['answered'] as string[]).length, 0);
});

test('metricProbe does not call a metric Graph never returned "accepted" when the other came back empty', async () => {
  const fb = createFakeFbRequest();
  // Graph answered page_follows with zero points and said nothing at all about
  // page_media_view: one accepted-but-empty metric, one absent entry.
  fb.on(
    (req) => req.path === '/1010/insights',
    fbOk({ data: [insightsEntry('page_follows', 0)] }),
  );

  const result = await metricProbe(probePages())(probeContext(fb).ctx);

  assert.equal(result.available, false);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.details?.['empty'], ['page_follows']);
  assert.deepEqual(result.details?.['unavailable'], ['page_media_view']);
  // The summary is the line the operator reads; it must not claim Graph
  // accepted a name it never mentioned, and it must name that name.
  assert.doesNotMatch(result.summary, /accepted the metrics/);
  assert.match(result.summary, /no data for page_follows/);
  assert.match(result.summary, /no entry for page_media_view/);
  // The accepted-but-empty half still carries both indistinguishable causes.
  assert.match(result.summary, /eligibility floor/);
  assert.match(result.summary, /read_insights/);
});

test('adAccountProbe reports "not configured" without calling Graph', async () => {
  const fb = createFakeFbRequest();

  const result = await adAccountProbe()(probeContext(fb).ctx);

  assert.equal(result.available, false);
  assert.match(result.summary, /FB_AD_ACCOUNT_ID/);
  assert.equal(fb.calls.length, 0, 'an unconfigured probe must make no Graph call');
});

test('adAccountProbe reports a serving ad account', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (req) => req.path === '/act_12345',
    fbOk({ id: 'act_12345', account_status: 1, currency: 'EUR' }),
  );

  const { ctx } = probeContext(fb, { FB_AD_ACCOUNT_ID: '12345' });
  const result = await adAccountProbe()(ctx);

  assert.equal(result.available, true);
  assert.match(result.summary, /act_12345/);
  assert.equal(result.details?.['currency'], 'EUR');
});

test('adAccountProbe prints the account money headroom (A1)', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (req) => req.path === '/act_12345',
    fbOk({
      id: 'act_12345',
      account_status: 1,
      currency: 'EUR',
      spend_cap: '100000',
      amount_spent: '25000',
    }),
  );

  const { ctx } = probeContext(fb, { FB_AD_ACCOUNT_ID: '12345' });
  const result = await adAccountProbe()(ctx);

  assert.match(
    result.summary,
    /Account spend limit: 100000 minor units of EUR, spent: 25000 minor units of EUR, remaining: 75000 minor units of EUR\./,
  );
  assert.equal(result.details?.['spendCapMinor'], 100_000);
  assert.equal(result.details?.['amountSpentMinor'], 25_000);
  assert.equal(result.details?.['headroomMinor'], 75_000);
});

test('adAccountProbe surfaces the disable reason and omits an absent currency', async () => {
  const fb = createFakeFbRequest();
  // A disabled account with no currency: the reason is the only thing that
  // tells the operator whether this is fixable in Ads Manager at all.
  fb.on(
    (req) => req.path === '/act_12345',
    fbOk({ id: 'act_12345', account_status: 2, disable_reason: 1 }),
  );

  const { ctx } = probeContext(fb, { FB_AD_ACCOUNT_ID: 'act_12345' });
  const result = await adAccountProbe()(ctx);

  assert.equal(result.available, false, 'a disabled account must not read as serving');
  assert.equal(result.details?.['statusLabel'], 'DISABLED');
  assert.equal(result.details?.['disableReason'], 'ADS_INTEGRITY_POLICY');
  // Absent, not null — the details map is read by an operator, and `currency:
  // null` would look like a second fault.
  assert.ok(!('currency' in (result.details ?? {})));
});

test('the probes mark "configured but unhealthy" so the doctor can tell it from "not configured" (wave 9)', async () => {
  // A configured ad account Graph says cannot serve: the exact situation the
  // probe exists to surface (CC-ADS-6). It used to answer the same
  // `available: false` an UNCONFIGURED account does, so the doctor's verdict
  // could not tell them apart and printed it above "OK — nothing needs attention".
  const disabledFb = createFakeFbRequest();
  disabledFb.on(
    (req) => req.path === '/act_12345',
    fbOk({ id: 'act_12345', account_status: 2, disable_reason: 1 }),
  );
  const disabled = await adAccountProbe()(
    probeContext(disabledFb, { FB_AD_ACCOUNT_ID: 'act_12345' }).ctx,
  );
  assert.equal(disabled.available, false);
  assert.equal(disabled.degraded, true, 'a configured, non-serving account is degraded');

  // A Page that accepted the metric names and returned nothing: the operator
  // has something to do (floor, scope or task), so the doctor must say so.
  const emptyFb = createFakeFbRequest();
  emptyFb.on(
    (req) => req.path === '/1010/insights',
    fbOk({
      data: [insightsEntry('page_media_view', 0), insightsEntry('page_follows', 0)],
    }),
  );
  const empty = await metricProbe(probePages())(probeContext(emptyFb).ctx);
  assert.equal(empty.available, false);
  assert.equal(empty.degraded, true, 'an empty-insights Page is degraded');

  // Graph returned no entry at all: the pinned names are not valid for this
  // API version, so the probe cannot judge the Page. Not the operator's Page,
  // but still an install that cannot read insights as pinned — degraded too.
  const noEntryFb = createFakeFbRequest();
  noEntryFb.on((req) => req.path === '/1010/insights', fbOk({ data: [] }));
  const noEntry = await metricProbe(probePages())(probeContext(noEntryFb).ctx);
  assert.equal(noEntry.available, false);
  assert.equal(noEntry.degraded, true, 'unknown metric names are degraded');

  // Controls: nothing to check is NOT unhealthy, and a healthy answer carries
  // no flag either — `degraded` is absent, not `false`, in both.
  const unconfigured = await adAccountProbe()(probeContext(createFakeFbRequest()).ctx);
  assert.equal(unconfigured.available, false);
  assert.ok(
    !('degraded' in unconfigured),
    'an unconfigured ad account must carry no flag',
  );

  const servingFb = createFakeFbRequest();
  servingFb.on(
    (req) => req.path === '/act_12345',
    fbOk({ id: 'act_12345', account_status: 1, currency: 'EUR' }),
  );
  const serving = await adAccountProbe()(
    probeContext(servingFb, { FB_AD_ACCOUNT_ID: '12345' }).ctx,
  );
  assert.equal(serving.available, true);
  assert.ok(!('degraded' in serving), 'a serving account must carry no flag');

  const answeringFb = createFakeFbRequest();
  answeringFb.on(
    (req) => req.path === '/1010/insights',
    fbOk({ data: [insightsEntry('page_media_view', 2)] }),
  );
  const answering = await metricProbe(probePages())(probeContext(answeringFb).ctx);
  assert.equal(answering.available, true);
  assert.ok(!('degraded' in answering), 'an answering Page must carry no flag');
});

test('both probes forward an abort signal to Graph', async () => {
  const controller = new AbortController();

  const insightsFb = createFakeFbRequest();
  insightsFb.on(
    (req) => req.path === '/1010/insights',
    fbOk({ data: [insightsEntry('page_media_view', 1)] }),
  );
  await metricProbe(probePages())(probeContext(insightsFb, {}, controller.signal).ctx);
  assert.equal(insightsFb.calls[0]?.signal, controller.signal);

  const adsFb = createFakeFbRequest();
  adsFb.on(
    (req) => req.path === '/act_12345',
    fbOk({ id: 'act_12345', account_status: 1, currency: 'EUR' }),
  );
  await adAccountProbe()(
    probeContext(adsFb, { FB_AD_ACCOUNT_ID: '12345' }, controller.signal).ctx,
  );
  assert.equal(adsFb.calls[0]?.signal, controller.signal);
});
