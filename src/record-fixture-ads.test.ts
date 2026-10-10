// Fixture recorder, ads mode (`scripts/record-fixture.mjs --ads`).
//
// Ads mode records the Marketing API read set the `ads` package uses, on the
// ADS pin, into `test/fixtures/ads/<ads-version>/`, so an ads pin bump can be
// shape-diffed old-version directory against new-version directory. What has to
// hold, and is pinned here offline:
//
//   1. it is read-only: every planned request is a GET tagged `api: 'marketing'`
//      (versioned by the ads pin), the async report start (a POST) is not in the
//      plan, and the field sets are the ones the tools actually request;
//   2. it is gated: the recorder's own gate first, then FB_AD_ACCOUNT_ID — a
//      missing account is a clean skip (exit 0, no call, no file), a malformed
//      one a refusal that never echoes the value;
//   3. the anonymiser removes ad business data (ids, names, amounts, cursors)
//      while keeping every JSON type, consistently across the files of one run,
//      and its output passes the committed fixture-lint;
//   4. the directory layout is one the shape-diff tool compares directly.
//
// Nothing here touches the network. The spawned runs import the network fence
// and stop before any request (skip or refusal) by construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as adsRead from './api/ads-read.js';
import { DEFAULT_ADS_API_VERSION } from './core/index.js';
import { findSecrets } from './testing/fixtures.js';

/** This file compiles to `build/record-fixture-ads.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'record-fixture.mjs');
const FENCE = join(REPO_ROOT, 'build', 'testing', 'network-fence.js');

interface PlannedRequest {
  readonly out: string;
  readonly method: string;
  readonly api: string;
  readonly path: string;
  readonly params: Record<string, string | number>;
}

interface LevelSpec {
  readonly level: string;
  readonly edge: string;
  readonly listOut: string;
  readonly detailOut: string;
}

interface Shape {
  readonly kinds: string[];
}

interface Recorder {
  readonly EXIT: {
    readonly ok: number;
    readonly failed: number;
    readonly refused: number;
  };
  readonly ADS_ACCOUNT_VAR: string;
  readonly ADS_FIXTURE_FILES: readonly string[];
  readonly ADS_LEVELS: readonly LevelSpec[];
  readonly parseCliArgs: (argv: readonly string[]) => {
    readonly help: boolean;
    readonly ads: boolean;
    readonly method: string;
    readonly force: boolean;
  };
  readonly resolveAdsAccount: (raw: unknown) => string | null;
  readonly adsFixtureDir: (version: unknown) => string;
  readonly adsSkipMessage: () => string;
  readonly planAdsRecordings: (accountId: string, fields: unknown) => PlannedRequest[];
  readonly planAdsObjectRead: (
    level: LevelSpec,
    body: unknown,
    fields: unknown,
  ) => PlannedRequest | null;
  readonly createAdsAnonymizer: () => { anonymize: (value: unknown) => unknown };
  readonly redactSecrets: (value: unknown) => unknown;
}

interface ShapeDiff {
  readonly shapeOf: (value: unknown) => Shape;
  readonly diffShapes: (a: Shape, b: Shape) => unknown[];
}

// Computed specifiers: the scripts live outside `rootDir` (same convention as
// `src/record-fixture.test.ts`).
const recorder = (await import(pathToFileURL(SCRIPT).href)) as Recorder;
const shapeDiff = (await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'fixture-shape-diff.mjs')).href
)) as ShapeDiff;

const {
  EXIT,
  ADS_ACCOUNT_VAR,
  ADS_FIXTURE_FILES,
  ADS_LEVELS,
  parseCliArgs,
  resolveAdsAccount,
  adsFixtureDir,
  adsSkipMessage,
  planAdsRecordings,
  planAdsObjectRead,
  createAdsAnonymizer,
  redactSecrets,
} = recorder;

function refuses(fn: () => unknown, expected: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, 'a non-Error was thrown');
    assert.equal(err.name, 'RecordError', `expected a RecordError, got ${err.name}`);
    assert.match(err.message, expected);
    return true;
  });
}

const levelSpec = (level: string): LevelSpec => {
  const spec = ADS_LEVELS.find((l) => l.level === level);
  assert.ok(spec, `no level spec for ${level}`);
  return spec;
};

// ---------------------------------------------------------------------------
// 1. CLI
// ---------------------------------------------------------------------------

test('--ads parses as its own mode, GET only', () => {
  const parsed = parseCliArgs(['--ads']);
  assert.equal(parsed.ads, true);
  assert.equal(parsed.method, 'GET');
  assert.equal(parsed.force, false);
  assert.equal(parseCliArgs(['--ads', '--force']).force, true);
  assert.equal(parseCliArgs(['--endpoint', 'me', '--out', 'me.json']).ads, false);
});

test('--ads refuses a non-GET method and a single-endpoint argument', () => {
  refuses(() => parseCliArgs(['--ads', '--method', 'POST']), /only ever issues GETs/);
  refuses(() => parseCliArgs(['--ads', '--endpoint', 'me']), /cannot be combined/);
  refuses(() => parseCliArgs(['--ads', '--out', 'x.json']), /cannot be combined/);
});

// ---------------------------------------------------------------------------
// 2. Account gate and directory layout
// ---------------------------------------------------------------------------

test('no configured ad account means a skip, not a refusal', () => {
  for (const raw of [undefined, null, '', '   ']) {
    assert.equal(resolveAdsAccount(raw), null, `${JSON.stringify(raw)} must skip`);
  }
  const message = adsSkipMessage();
  assert.match(message, new RegExp(ADS_ACCOUNT_VAR));
  assert.match(message, /no network call was made and no file was written/);
});

test('the ad account normalises to act_<digits>', () => {
  assert.equal(resolveAdsAccount('1234567890'), 'act_1234567890');
  assert.equal(resolveAdsAccount(' act_1234567890 '), 'act_1234567890');
});

test('a malformed ad account is refused without echoing the value', () => {
  for (const raw of ['act-123', 'my-account-secret', '123abc', 'acct_99']) {
    assert.throws(
      () => resolveAdsAccount(raw),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'RecordError');
        assert.match(err.message, new RegExp(ADS_ACCOUNT_VAR));
        assert.ok(!err.message.includes(raw), `the value leaked: ${err.message}`);
        return true;
      },
    );
  }
});

test('fixtures are versioned by the ads pin, one directory per version', () => {
  assert.equal(adsFixtureDir('v26.0'), 'ads/v26.0/');
  assert.equal(
    adsFixtureDir(DEFAULT_ADS_API_VERSION),
    `ads/${DEFAULT_ADS_API_VERSION}/`,
    'the default ads pin must name a valid fixture directory',
  );
  // The version becomes a path segment: nothing but vNN.N may get through.
  for (const bad of ['../v26.0', 'v26', 'latest', 'v26.0/..', '', undefined]) {
    refuses(() => adsFixtureDir(bad), /must look like v26\.0/);
  }
});

test('the fixture file set is unique, bare *.json names', () => {
  assert.equal(new Set(ADS_FIXTURE_FILES).size, ADS_FIXTURE_FILES.length);
  for (const name of ADS_FIXTURE_FILES) {
    assert.match(name, /^ads-[a-z]+\.json$/);
  }
});

// ---------------------------------------------------------------------------
// 3. The plan: read-only, ads pin, the tools' own field sets
// ---------------------------------------------------------------------------

test('every planned request is a GET on the Marketing API family', () => {
  const plan = planAdsRecordings('act_42', adsRead);

  assert.deepEqual(
    plan.map((p) => p.out),
    [
      'ads-account.json',
      'ads-campaigns.json',
      'ads-adsets.json',
      'ads-ads.json',
      'ads-insights.json',
    ],
  );
  for (const p of plan) {
    assert.equal(p.method, 'GET', `${p.out} is not a GET`);
    assert.equal(p.api, 'marketing', `${p.out} would ride the Graph pin`);
    assert.ok(p.path.startsWith('/act_42'), `${p.out} leaves the account: ${p.path}`);
    assert.ok(!('access_token' in p.params), `${p.out} carries a token param`);
    assert.ok(ADS_FIXTURE_FILES.includes(p.out));
  }
});

test('the plan asks for exactly the field sets the ads tools ask for', () => {
  const byOut = new Map(planAdsRecordings('act_42', adsRead).map((p) => [p.out, p]));

  assert.equal(
    byOut.get('ads-account.json')?.params['fields'],
    adsRead.AD_ACCOUNT_FIELDS,
  );
  for (const level of adsRead.AD_LEVELS) {
    const spec = levelSpec(level);
    const p = byOut.get(spec.listOut);
    assert.ok(p);
    assert.equal(p.path, `/act_42/${adsRead.AD_LEVEL_EDGES[level]}`);
    assert.equal(
      p.params['fields'],
      adsRead.withPinnedAdFields(adsRead.AD_LEVEL_LIST_FIELDS[level]),
    );
  }
  const insights = byOut.get('ads-insights.json');
  assert.ok(insights);
  assert.equal(insights.path, '/act_42/insights');
  assert.equal(insights.params['fields'], adsRead.ADS_INSIGHTS_DEFAULT_FIELDS);
});

test('the async report start is not recorded — it is a POST', () => {
  const plan = planAdsRecordings('act_42', adsRead);
  assert.ok(plan.every((p) => p.method === 'GET'));
  // A sync insights GET is in; nothing that could create a report run is.
  assert.equal(plan.filter((p) => p.path.endsWith('/insights')).length, 1);
});

test('an object read follows the first listed id with the detail field set', () => {
  const spec = levelSpec('adset');
  const read = planAdsObjectRead(spec, { data: [{ id: '777' }, { id: '888' }] }, adsRead);

  assert.ok(read);
  assert.equal(read.out, 'ads-adset.json');
  assert.equal(read.method, 'GET');
  assert.equal(read.api, 'marketing');
  assert.equal(read.path, '/777');
  assert.equal(
    read.params['fields'],
    adsRead.withPinnedAdFields(adsRead.AD_LEVEL_DETAIL_FIELDS.adset),
  );
});

test('an empty listing skips its object read instead of inventing one', () => {
  const spec = levelSpec('ad');
  for (const body of [
    { data: [] },
    {},
    null,
    { data: [{ id: '../me' }] },
    { data: [{}] },
  ]) {
    assert.equal(planAdsObjectRead(spec, body, adsRead), null, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------------------
// 4. Anonymisation
// ---------------------------------------------------------------------------

const REAL_ACCOUNT = '120200000000123';
const REAL_CAMPAIGN = '120210000000456';
const REAL_ADSET = '120220000000789';

function rawCampaigns(): unknown {
  return {
    data: [
      {
        id: REAL_CAMPAIGN,
        name: 'Acme Spring Sale 2026',
        status: 'ACTIVE',
        effective_status: 'ACTIVE',
        objective: 'OUTCOME_TRAFFIC',
        daily_budget: '2500',
        updated_time: '2026-10-01T10:00:00+0000',
      },
    ],
    paging: {
      cursors: {
        before: 'QVFIUjEyMDIxMDAwMDAwMDQ1Ng',
        after: 'QVFIUjEyMDIxMDAwMDAwMDQ1Ng',
      },
      next: `https://graph.facebook.com/v26.0/act_${REAL_ACCOUNT}/campaigns?after=QVFI&limit=5`,
    },
  };
}

function rawAdsets(): unknown {
  return {
    data: [
      {
        id: REAL_ADSET,
        name: 'Acme lookalike 1%',
        campaign_id: REAL_CAMPAIGN,
        bid_amount: '150',
        account_id: REAL_ACCOUNT,
      },
    ],
  };
}

function rawAccount(): unknown {
  return {
    id: `act_${REAL_ACCOUNT}`,
    account_id: REAL_ACCOUNT,
    name: 'Acme Ltd ad account',
    account_status: 1,
    disable_reason: 0,
    currency: 'EUR',
    timezone_name: 'Europe/Sofia',
  };
}

function rawInsights(): unknown {
  return {
    data: [
      {
        impressions: '18342',
        clicks: '412',
        spend: '48.10',
        ctr: '2.246211',
        account_currency: 'EUR',
        actions: [{ action_type: 'link_click', value: '398' }],
        date_start: '2026-09-10',
        date_stop: '2026-10-09',
      },
    ],
  };
}

test('ids map to the same fake id across every file of one run', () => {
  const { anonymize } = createAdsAnonymizer();
  const campaigns = anonymize(rawCampaigns()) as { data: { id: string }[] };
  const adsets = anonymize(rawAdsets()) as {
    data: { id: string; campaign_id: string; account_id: string }[];
  };
  const account = anonymize(rawAccount()) as { id: string; account_id: string };

  const campaignId = campaigns.data[0]?.id;
  assert.ok(campaignId !== undefined && campaignId !== REAL_CAMPAIGN);
  assert.match(campaignId, /^\d+$/, 'an id must stay a digit string');
  assert.equal(adsets.data[0]?.campaign_id, campaignId, 'the parent chain broke');
  assert.equal(account.id, `act_${account.account_id}`, 'the act_ form must be kept');
  assert.equal(adsets.data[0]?.account_id, account.account_id);
  assert.notEqual(account.account_id, REAL_ACCOUNT);
});

test('no real id, name, amount or cursor survives', () => {
  const { anonymize } = createAdsAnonymizer();
  const out = JSON.stringify(
    [rawAccount(), rawCampaigns(), rawAdsets(), rawInsights()].map((b) => anonymize(b)),
  );

  for (const leaked of [
    REAL_ACCOUNT,
    REAL_CAMPAIGN,
    REAL_ADSET,
    'Acme',
    '2500',
    '48.10',
    '18342',
    '398',
    'QVFIUjEy',
  ]) {
    assert.ok(!out.includes(leaked), `"${leaked}" survived anonymisation`);
  }
  // Enums and non-identifying context are kept: they carry the meaning a test needs.
  for (const kept of ['OUTCOME_TRAFFIC', 'EUR', '2026-09-10', 'link_click']) {
    assert.ok(out.includes(kept), `"${kept}" should have been kept`);
  }
});

test('anonymisation keeps every JSON type, so the shape-diff sees no change', () => {
  for (const raw of [rawAccount(), rawCampaigns(), rawAdsets(), rawInsights()]) {
    const anon = createAdsAnonymizer().anonymize(raw);
    assert.deepEqual(
      shapeDiff.diffShapes(shapeDiff.shapeOf(raw), shapeDiff.shapeOf(anon)),
      [],
      `the anonymiser changed a shape: ${JSON.stringify(anon)}`,
    );
  }
});

test('JSON numbers stay numbers; only a number under an id key is replaced', () => {
  const out = createAdsAnonymizer().anonymize({
    account_status: 1,
    disable_reason: 0,
    id: 120200000000999,
  }) as Record<string, unknown>;

  assert.equal(out['account_status'], 1);
  assert.equal(out['disable_reason'], 0);
  assert.equal(typeof out['id'], 'number');
  assert.notEqual(out['id'], 120200000000999);
});

test('id-keyed maps have their keys replaced too', () => {
  const out = createAdsAnonymizer().anonymize({
    [REAL_CAMPAIGN]: { id: REAL_CAMPAIGN },
  }) as Record<string, { id: string }>;

  const [key] = Object.keys(out);
  assert.ok(key !== undefined && key !== REAL_CAMPAIGN);
  assert.equal(out[key]?.id, key, 'the key and its id must map to the same fake');
});

test('anonymisation never mutates its input and is deterministic', () => {
  const input = rawCampaigns();
  const snapshot = JSON.stringify(input);

  const a = createAdsAnonymizer().anonymize(input);
  const b = createAdsAnonymizer().anonymize(rawCampaigns());

  assert.equal(JSON.stringify(input), snapshot, 'the input was mutated');
  assert.deepEqual(a, b, 'two runs over the same data disagree');
});

test('secret redaction plus anonymisation passes the committed fixture lint', () => {
  // The recorder runs the secret redaction first and the anonymiser second; the
  // result has to survive the very lint that guards test/fixtures/.
  const polluted = {
    data: [
      {
        id: REAL_CAMPAIGN,
        name: 'token EAABBBBccccDDDDeeeeFFFFgggg1234 in a name',
        note: `proof ${'a'.repeat(64)} and secret ${'f'.repeat(32)}`,
        access_token: 'EAABBBBccccDDDDeeeeFFFFgggg1234',
      },
    ],
    paging: { next: 'https://graph.facebook.com/x?access_token=EAAqqqqWWWWeeee5555rrrr' },
  };
  assert.ok(findSecrets(polluted).length > 0, 'the sample is not actually polluted');

  const out = createAdsAnonymizer().anonymize(redactSecrets(polluted));
  assert.deepEqual(findSecrets(out), []);
});

// ---------------------------------------------------------------------------
// 5. The gated entry point, end to end (no network: skip / refusal paths only)
// ---------------------------------------------------------------------------

/**
 * Run the recorder in a scrubbed environment: an empty temp HOME (so no real
 * env file is read), the network fence imported, and only the given variables.
 */
async function runAds(env: Record<string, string>): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const home = await mkdtemp(join(tmpdir(), 'fbmcp-record-ads-'));
  try {
    const result = spawnSync(process.execPath, ['--import', FENCE, SCRIPT, '--ads'], {
      cwd: home,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: home,
        XDG_STATE_HOME: home,
        APPDATA: home,
        LOCALAPPDATA: home,
        ...env,
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('--ads without the recorder gate is refused', async () => {
  const run = await runAds({});
  assert.equal(run.status, EXIT.refused, run.stderr);
  assert.match(run.stderr, /FB_RECORD_FIXTURE is not set/);
});

test('--ads without FB_AD_ACCOUNT_ID skips cleanly with exit 0', async () => {
  // No token either: the account check comes first, so an operator without an
  // ad account is told "skipped", not asked for a credential.
  const run = await runAds({ FB_RECORD_FIXTURE: '1' });
  assert.equal(run.status, EXIT.ok, run.stderr);
  assert.match(run.stdout, /^skipped: FB_AD_ACCOUNT_ID is not set/);
  assert.equal(run.stderr, '');
});

test('--ads with a malformed FB_AD_ACCOUNT_ID is refused before any call', async () => {
  const run = await runAds({
    FB_RECORD_FIXTURE: '1',
    FB_AD_ACCOUNT_ID: 'not-an-account',
  });
  assert.equal(run.status, EXIT.refused, run.stderr);
  assert.match(run.stderr, /FB_AD_ACCOUNT_ID must be act_<digits>/);
  assert.ok(!run.stderr.includes('not-an-account'), 'the value was echoed');
});

test('--ads with an account but no credential is refused, not attempted', async () => {
  const run = await runAds({ FB_RECORD_FIXTURE: '1', FB_AD_ACCOUNT_ID: 'act_42' });
  assert.equal(run.status, EXIT.refused, run.stderr);
  assert.match(run.stderr, /no access token configured/);
});
