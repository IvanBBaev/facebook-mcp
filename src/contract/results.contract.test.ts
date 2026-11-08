// Result goldens (R10; review findings QA-01, ARC-06).
//
// Each case below runs one `tools/call` through the real server against a canned
// Graph, and pins the answer to `test/contract/results/<case>.json`: one read per
// package, write previews, a refusal, an ambiguous write, a Graph failure, a
// rejected input and a CSV export. Every later task that changes a result shape
// shows it here as a golden diff (`test/contract/README.md`).
//
// Compact JSON text is stored parsed, so the diff is readable and a key order
// change is not one. The parse is taken only if it round-trips byte for byte: text
// that stops being compact JSON shows up as a `json` -> `text` change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ambiguousWriteAction,
  createRedactor,
  GraphApiError,
  loadSettings,
  type PackageSpec,
} from '../core/index.js';
import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createMemoryJournal,
  fbErr,
  fbOk,
  type FakeFbRequest,
} from '../core/fakes/index.js';
import { loadFixture } from '../testing/index.js';
import {
  createAdsPackage,
  createCorePackage,
  createInsightsPackage,
  createMessagesPackage,
  createModerationPackage,
  createPageAdminPackage,
  createPostsPackage,
  createReaderPackage,
} from '../tools/index.js';
import { buildServer } from '../index.js';

/** This file compiles to `build/contract/`, so the root is two levels up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Wire {
  request(method: string, params: unknown): Promise<unknown>;
  close(): Promise<void>;
}

interface WireModule {
  readonly CONTRACT_DIR: string;
  readonly CONTRACT_VERSIONS: { serverVersion: string; sdkVersion: string };
  updateRequested(): boolean;
  canonicalize(value: unknown): unknown;
  readGolden(path: string): unknown;
  writeGolden(path: string, value: unknown): Promise<void>;
  openWire(server: unknown): Promise<Wire>;
}

const wire = (await import(
  pathToFileURL(join(REPO_ROOT, 'test', 'contract', 'wire.mjs')).href
)) as WireModule;

const RESULTS_DIR = join(wire.CONTRACT_DIR, 'results');
const HINT = 'golden drift; if intended, UPDATE_CONTRACT=1 npm test and review the diff';

/** A fixed moment, so plan expiry and export names never move. */
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const PAGE = {
  pageId: '1000000001',
  name: 'Contract Page',
  token: 'page-token-contract',
};
const POST_ID = `${PAGE.pageId}_2000000002`;
const COMMENT_ID = `${POST_ID.split('_')[1]}_3000000003`;
const AD_ACCOUNT = 'act_4000000004';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const everyPackage = (): readonly PackageSpec[] =>
  [
    createCorePackage,
    createReaderPackage,
    createPostsPackage,
    createInsightsPackage,
    createModerationPackage,
    createMessagesPackage,
    createAdsPackage,
    createPageAdminPackage,
  ].map((factory) => factory(wire.CONTRACT_VERSIONS));

/** One tool call and the Graph it meets; `viaPlan` previews first and pins the apply. */
interface ContractCase {
  readonly name: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly graph?: (fb: FakeFbRequest) => void | Promise<void>;
  readonly viaPlan?: true;
}

const serve = (body: unknown) => (fb: FakeFbRequest) => {
  fb.on(() => true, fbOk(body));
};

const CASES: readonly ContractCase[] = [
  {
    name: 'read-core-get-page',
    tool: 'facebook_get_page',
    args: {},
    graph: async (fb) => {
      serve(await loadFixture('graph-page-profile.json'))(fb);
    },
  },
  {
    name: 'read-reader-list-posts',
    tool: 'facebook_list_posts',
    args: {},
    graph: async (fb) => {
      serve(await loadFixture('graph-feed.json'))(fb);
    },
  },
  {
    name: 'read-posts-list-scheduled',
    tool: 'facebook_list_scheduled_posts',
    args: {},
    graph: serve({ data: [] }),
  },
  {
    name: 'read-insights-page',
    tool: 'facebook_page_insights',
    args: { metrics: ['page_media_view'], since: '2026-01-01', until: '2026-01-03' },
    graph: serve({
      data: [
        {
          name: 'page_media_view',
          period: 'day',
          values: [
            { value: 10, end_time: '2026-01-02T08:00:00+0000' },
            { value: 12, end_time: '2026-01-03T08:00:00+0000' },
          ],
        },
      ],
    }),
  },
  {
    name: 'read-moderation-list-comments',
    tool: 'facebook_list_comments',
    args: { object_id: POST_ID },
    graph: serve({
      data: [
        {
          id: COMMENT_ID,
          message: 'First comment',
          created_time: '2026-01-02T08:00:00+0000',
          like_count: 1,
        },
      ],
    }),
  },
  {
    name: 'read-messages-list-conversations',
    tool: 'facebook_list_conversations',
    args: {},
    graph: serve({ data: [] }),
  },
  {
    name: 'read-ads-list-campaigns',
    tool: 'facebook_list_campaigns',
    args: { ad_account_id: AD_ACCOUNT },
    graph: serve({ data: [{ id: '5000000005', name: 'Campaign', status: 'PAUSED' }] }),
  },
  {
    name: 'preview-posts-create-post',
    tool: 'facebook_create_post',
    args: { message: 'Hello from the contract suite' },
  },
  {
    name: 'preview-page-admin-update-profile',
    tool: 'facebook_update_page_profile',
    args: { about: 'New about text' },
    graph: async (fb) => {
      serve(await loadFixture('graph-page-profile.json'))(fb);
    },
  },
  {
    name: 'refusal-apply-without-plan',
    tool: 'facebook_delete_post',
    args: { post_id: POST_ID, apply: true },
    graph: serve({
      id: POST_ID,
      message: 'A post',
      created_time: '2026-01-02T08:00:00+0000',
    }),
  },
  {
    name: 'error-ambiguous-write',
    tool: 'facebook_reply_to_comment',
    args: { comment_id: COMMENT_ID, message: 'Thanks' },
    viaPlan: true,
    graph: (fb) => {
      fb.on(
        (request) => request.method === 'POST',
        fbErr(
          new GraphApiError('response body lost after HTTP 200', {
            code: 0,
            httpStatus: 200,
            action: ambiguousWriteAction({ detail: 'response body lost' }),
          }),
        ),
      );
      serve({ id: COMMENT_ID, message: 'First comment' })(fb);
    },
  },
  {
    name: 'error-graph-permission',
    tool: 'facebook_list_posts',
    args: {},
    graph: (fb) => {
      fb.on(
        () => true,
        fbErr(
          new GraphApiError('(#200) Permissions error', { code: 200, httpStatus: 403 }),
        ),
      );
    },
  },
  {
    name: 'error-invalid-input',
    tool: 'facebook_get_post',
    args: { post_id: 42 },
  },
  {
    name: 'export-insights-csv',
    tool: 'facebook_page_insights',
    args: {
      metrics: ['page_media_view'],
      since: '2026-01-01',
      until: '2026-01-03',
      output: { format: 'csv' },
    },
    graph: serve({
      data: [
        {
          name: 'page_media_view',
          period: 'day',
          values: [{ value: 10, end_time: '2026-01-02T08:00:00+0000' }],
        },
      ],
    }),
  },
];

/** Replace what differs per run: plan ids and the per-run export directory. */
function scrub(value: unknown, exportDir: string): unknown {
  if (typeof value === 'string') {
    return value.replaceAll(exportDir, '<export-dir>').replace(UUID_RE, '<uuid>');
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, exportDir));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scrub(item, exportDir)]),
  );
}

/** Store compact JSON text parsed, when the parse is lossless. */
function readableBlock(block: unknown): unknown {
  const { text, ...rest } = block as { text?: unknown };
  if (typeof text !== 'string') return block;
  try {
    const json: unknown = JSON.parse(text);
    return JSON.stringify(json) === text ? { ...rest, json } : block;
  } catch {
    return block;
  }
}

interface ToolResult {
  readonly content: readonly unknown[];
}

/** Run one case on a fresh server and return its golden form. */
async function run(testCase: ContractCase): Promise<unknown> {
  const exportDir = mkdtempSync(join(tmpdir(), 'fb-contract-'));
  const clock = createFakeClock(NOW);
  const fb = createFakeFbRequest();
  await testCase.graph?.(fb);
  const { settings } = loadSettings({
    env: {
      FB_ACCESS_TOKEN: 'placeholder-token',
      FB_TOOL_PACKAGES: 'all',
      FB_EXPORT_DIR: exportDir,
    },
    loadEnvFile: false,
  });
  const session = await wire.openWire(
    buildServer({
      settings,
      packages: everyPackage(),
      serverVersion: wire.CONTRACT_VERSIONS.serverVersion,
      clock,
      logger: silentLogger,
      redactor: createRedactor(),
      journal: createMemoryJournal(clock),
      fbRequest: fb.fn,
      pages: createFakePageResolver({ default: PAGE }),
    }),
  );
  try {
    const call = (args: unknown): Promise<ToolResult> =>
      session.request('tools/call', {
        name: testCase.tool,
        arguments: args,
      }) as Promise<ToolResult>;
    let result = await call(testCase.args);
    if (testCase.viaPlan === true) {
      const { text } = result.content[0] as { text: string };
      const { planId } = JSON.parse(text) as { planId: string };
      result = await call({ ...testCase.args, apply: true, plan_id: planId });
    }
    const files = readdirSync(exportDir).map((name) => ({
      name,
      lines: readFileSync(join(exportDir, name), 'utf8').split('\r\n'),
    }));
    return {
      tool: testCase.tool,
      arguments: testCase.args,
      result: scrub({ ...result, content: result.content.map(readableBlock) }, exportDir),
      ...(files.length > 0 ? { files } : {}),
    };
  } finally {
    await session.close();
    rmSync(exportDir, { recursive: true, force: true });
  }
}

for (const testCase of CASES) {
  test(`result golden: ${testCase.name}`, async () => {
    const path = join(RESULTS_DIR, `${testCase.name}.json`);
    const live = await run(testCase);
    if (wire.updateRequested()) {
      await wire.writeGolden(path, live);
      return;
    }
    assert.deepEqual(wire.canonicalize(live), wire.readGolden(path), HINT);
  });
}

test('every result golden belongs to a case, and every package has a read or preview', () => {
  const names = CASES.map((testCase) => `${testCase.name}.json`).sort();
  assert.deepEqual(readdirSync(RESULTS_DIR).sort(), names);

  const covered = new Set(
    CASES.flatMap(({ tool }) =>
      everyPackage()
        .filter((pkg) => pkg.tools.some((spec) => spec.name === tool))
        .map((pkg) => pkg.name),
    ),
  );
  assert.deepEqual(
    [...covered].sort(),
    everyPackage()
      .map((pkg) => pkg.name)
      .sort(),
  );
});
