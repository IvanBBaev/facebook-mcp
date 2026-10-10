// The offline run plan (`npm run smoke:plan`, `scripts/smoke/plan.mjs`) and the
// `effects` declaration it is built from.
//
// The plan is the operator's last look before the harness writes to a real
// Page, so two things are pinned here. First, every registered smoke declares
// what it creates, cleans up and leaves (`effects`): the plan has no other
// source for those lines, and a smoke that omitted them would print as if it
// did nothing. Second, the plan's verdict: every problem the live run would
// refuse on is reported at once, shapes the live run only discovers mid-run are
// caught up front, and no token value ever reaches the printed text.
//
// Like `src/smoke-harness.test.ts`, nothing here opens a socket or spawns the
// server: the plan is offline by design, and the only I/O is local `fs` checks
// against throwaway temp directories, plus `run.mjs` children that refuse before
// loading any smoke.

import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This file compiles to `build/smoke-plan.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const smokeFile = (name: string): string =>
  pathToFileURL(join(REPO_ROOT, 'scripts', 'smoke', name)).href;

type SmokeEnv = Record<string, string | undefined>;

interface Effects {
  readonly creates: readonly string[];
  readonly cleansUp: readonly string[];
  readonly leaves: readonly string[];
}

interface RegisteredSmoke {
  readonly id: string;
  readonly phase: number;
  readonly writes: boolean;
  readonly budget: string | null;
  readonly requires: readonly string[];
  readonly effects: Effects;
}

interface RegisteredSweeper {
  readonly id: string;
  readonly title: string;
  readonly packages: readonly string[];
}

interface RegistryModule {
  readonly EFFECT_KEYS: readonly string[];
  readonly SmokeRegistrationError: new (message: string) => Error;
  registerSmoke(spec: Record<string, unknown>): void;
  resetRegistry(): void;
  listSmokes(): readonly RegisteredSmoke[];
  listSweepers(): readonly RegisteredSweeper[];
  loadModules(dir: string, suffix: string): Promise<void>;
}

interface PlanArgs {
  only: readonly string[];
  phases: readonly number[];
  includeBudget: boolean;
  sweepOnly: boolean;
  keep: boolean;
  serverPath: string;
}

interface PlanRow {
  readonly smoke: RegisteredSmoke;
  readonly status: 'run' | 'skip' | 'blocked';
  readonly reason: string;
}

interface Plan {
  readonly runnable: boolean;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  readonly rows: readonly PlanRow[];
  readonly leftBehind: readonly { id: string; item: string }[];
  readonly command: string;
}

interface PlanModule {
  readonly MIN_CONFIRM_TOKEN_CHARS: number;
  closestName(name: string, candidates: Iterable<string>): string | undefined;
  envNameProblems(
    env: SmokeEnv,
    smokes?: readonly RegisteredSmoke[],
  ): { problems: readonly string[]; warnings: readonly string[] };
  buildPlan(input: {
    env: SmokeEnv;
    args: PlanArgs;
    smokes: readonly RegisteredSmoke[];
    sweepers: readonly RegisteredSweeper[];
  }): Plan;
  formatPlan(plan: Plan, env: SmokeEnv): string;
}

interface RunnerModule {
  readonly EXIT: Readonly<Record<'ok' | 'failed' | 'refused', number>>;
  parseCliArgs(argv: readonly string[]): PlanArgs & { plan: boolean };
}

const registry = (await import(smokeFile('registry.mjs'))) as RegistryModule;
const plan = (await import(smokeFile('plan.mjs'))) as PlanModule;
const runner = (await import(smokeFile('run.mjs'))) as RunnerModule;

// The real registry, loaded the way `run.mjs` loads it. Snapshotted, because the
// registration tests below reset the shared registry and ESM caches the modules
// (a second `loadModules` would not re-register them).
await registry.loadModules(join(REPO_ROOT, 'scripts', 'smoke', 'smokes'), '.smoke.mjs');
await registry.loadModules(join(REPO_ROOT, 'scripts', 'smoke', 'sweepers'), '.sweep.mjs');
const SMOKES = [...registry.listSmokes()];
const SWEEPERS = [...registry.listSweepers()];

/** Distinctive fake secrets, so a leak into the printed plan is unmistakable. */
const SYSTEM_TOKEN = 'SECRETsystemtoken0123456789';
const TEST_TOKEN = 'SECRETtestpagetoken0123456789';
const CONFIRM_TOKEN = 'SECRETconfirm-0123456789abcdef';

/** A file that always exists, standing in for `build/index.js`. */
const BUILT_SERVER = join(REPO_ROOT, 'package.json');

/** A temp media dir with a 1-byte `probe.mp4`, removed after the test. */
function mediaFixture(t: { after(fn: () => void): void }): { dir: string; reel: string } {
  const root = mkdtempSync(join(tmpdir(), 'smoke-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'media');
  mkdirSync(dir);
  const reel = join(dir, 'probe.mp4');
  writeFileSync(reel, 'x');
  return { dir, reel };
}

/** An environment the default selection accepts. */
function goodEnv(extra: SmokeEnv = {}): SmokeEnv {
  return {
    FB_SYSTEM_TOKEN: SYSTEM_TOKEN,
    FB_SMOKE_PAGE_ID: '111111111111111',
    FB_SMOKE_TEST_PAGE_ID: '222222222222222',
    FB_CONFIRM_TOKEN: CONFIRM_TOKEN,
    FB_SMOKE_PHOTO_URL: 'https://example.com/photo.jpg',
    ...extra,
  };
}

function planFor(env: SmokeEnv, args: Partial<PlanArgs> = {}): Plan {
  return plan.buildPlan({
    env,
    args: {
      only: [],
      phases: [],
      includeBudget: false,
      sweepOnly: false,
      keep: false,
      serverPath: BUILT_SERVER,
      ...args,
    },
    smokes: SMOKES,
    sweepers: SWEEPERS,
  });
}

function rowOf(p: Plan, id: string): PlanRow {
  const row = p.rows.find((r) => r.smoke.id === id);
  assert.ok(row, `the plan has a row for ${id}`);
  return row;
}

const hasProblem = (p: Plan, pattern: RegExp): boolean =>
  p.problems.some((problem) => pattern.test(problem));

// --- the effects declaration -------------------------------------------------

test('every registered smoke declares effects that agree with writes', () => {
  assert.ok(SMOKES.length > 0, 'the real registry loaded');
  for (const smoke of SMOKES) {
    const { effects } = smoke;
    assert.deepEqual(
      Object.keys(effects).sort(),
      [...registry.EFFECT_KEYS].sort(),
      smoke.id,
    );
    if (smoke.writes) {
      assert.ok(effects.creates.length > 0, `${smoke.id} says what it creates`);
      assert.ok(
        effects.cleansUp.length + effects.leaves.length > 0,
        `${smoke.id} says how it cleans up or what it leaves`,
      );
    } else {
      assert.deepEqual(effects, { creates: [], cleansUp: [], leaves: [] }, smoke.id);
    }
  }
});

test('the draft Reel smoke declares the Reel it leaves behind', () => {
  const reel = SMOKES.find((smoke) => smoke.id === 'reels/create-and-status');
  assert.ok(reel);
  assert.equal(reel.effects.cleansUp.length, 0);
  assert.match(reel.effects.leaves.join('\n'), /DRAFT Reel/);
});

test('registration refuses a missing, malformed or inconsistent effects', (t) => {
  t.after(() => registry.resetRegistry());
  registry.resetRegistry();
  const base = { phase: 2, title: 'fake', page: 'test', run: () => Promise.resolve() };
  const refused: readonly [string, Record<string, unknown>][] = [
    ['missing', { writes: true }],
    ['missing on a reader', { writes: false }],
    ["'none' on a writer", { writes: true, effects: 'none' }],
    [
      'an object on a reader',
      { writes: false, effects: { creates: ['x'], cleansUp: ['x'], leaves: [] } },
    ],
    [
      'an unknown key',
      {
        writes: true,
        effects: { creates: ['x'], cleansUp: ['x'], leaves: [], extra: [] },
      },
    ],
    [
      'a non-array',
      { writes: true, effects: { creates: 'x', cleansUp: ['x'], leaves: [] } },
    ],
    [
      'an empty string',
      { writes: true, effects: { creates: [''], cleansUp: ['x'], leaves: [] } },
    ],
    [
      'nothing created',
      { writes: true, effects: { creates: [], cleansUp: ['x'], leaves: [] } },
    ],
    [
      'neither cleanup nor leave',
      { writes: true, effects: { creates: ['x'], cleansUp: [], leaves: [] } },
    ],
  ];
  for (const [label, spec] of refused) {
    assert.throws(
      () =>
        registry.registerSmoke({
          ...base,
          id: `fake/${label.replace(/\W+/g, '-')}`,
          ...spec,
        }),
      registry.SmokeRegistrationError,
      label,
    );
  }
  registry.registerSmoke({
    ...base,
    id: 'fake/leaves-only',
    writes: true,
    effects: { creates: ['x'], cleansUp: [], leaves: ['x'] },
  });
  registry.registerSmoke({
    ...base,
    id: 'fake/reader',
    page: 'read',
    writes: false,
    effects: 'none',
  });
  assert.equal(registry.listSmokes().length, 2);
});

// --- names -------------------------------------------------------------------

test('a misspelt variable name gets the closest real one', () => {
  const candidates = ['FB_SMOKE_TEST_PAGE_ID', 'FB_SMOKE_PAGE_ID', 'FB_CONFIRM_TOKEN'];
  assert.equal(
    plan.closestName('FB_SMOKE_TEST_PAGEID', candidates),
    'FB_SMOKE_TEST_PAGE_ID',
  );
  assert.equal(
    plan.closestName('FB_SMOKE_CONFIRM_TOKEN', candidates),
    'FB_CONFIRM_TOKEN',
  );
  assert.equal(plan.closestName('FB_SMOKE_READ_PAGE_ID', candidates), 'FB_SMOKE_PAGE_ID');
  assert.equal(
    plan.closestName('FB_SMOKE_SOMETHING_ELSE_ENTIRELY', candidates),
    undefined,
  );
});

test('unknown FB_SMOKE names, a non-1 gate and the rehearsal switches are problems', () => {
  const { problems } = plan.envNameProblems(
    {
      FB_SMOKE: 'true',
      FB_SMOKE_TEST_PAGEID: '1',
      FB_SMOKE_REHEARSAL_PRELOAD: '0',
      FB_SMOKE_PAGE_ID: '1',
    },
    SMOKES,
  );
  assert.ok(
    problems.some((p) =>
      /FB_SMOKE_TEST_PAGEID.*did you mean FB_SMOKE_TEST_PAGE_ID/.test(p),
    ),
  );
  assert.ok(problems.some((p) => /FB_SMOKE_REHEARSAL_PRELOAD/.test(p)));
  assert.ok(problems.some((p) => /^FB_SMOKE\b/.test(p)));
  assert.ok(
    !problems.some((p) => /^FB_SMOKE_PAGE_ID\b/.test(p)),
    'a real name is not flagged',
  );
});

// --- the verdict -------------------------------------------------------------

test('a complete environment yields a runnable plan with the live command', () => {
  const p = planFor(goodEnv());
  assert.deepEqual(p.problems, []);
  assert.equal(p.runnable, true);
  assert.equal(p.command, 'FB_SMOKE=1 npm run smoke');
  assert.ok(p.rows.some((row) => row.status === 'run' && row.smoke.writes));
});

test('every problem is reported at once, not just the first', () => {
  const p = planFor(
    {
      FB_SYSTEM_TOKEN: `Bearer ${SYSTEM_TOKEN}`,
      FB_SMOKE_PAGE_ID: 'my-page',
      FB_SMOKE_TEST_PAGEID: '222',
      FB_CONFIRM_TOKEN: 'short',
      FB_AD_ACCOUNT_ID: 'act-123',
    },
    { includeBudget: true },
  );
  assert.equal(p.runnable, false);
  assert.ok(hasProblem(p, /FB_SMOKE_TEST_PAGEID.*FB_SMOKE_TEST_PAGE_ID/), 'typo');
  assert.ok(hasProblem(p, /FB_SMOKE_PAGE_ID/), 'non-numeric Page id');
  assert.ok(hasProblem(p, /Bearer/), 'Bearer prefix');
  assert.ok(
    hasProblem(p, new RegExp(`${plan.MIN_CONFIRM_TOKEN_CHARS}`)),
    'short confirm token',
  );
  assert.ok(hasProblem(p, /act_123/), 'ad account shape, with the corrected form');
  assert.ok(p.problems.length >= 5);
});

test('the ad account id accepts act_<digits> and bare digits only', () => {
  for (const good of ['act_123456', '123456']) {
    const p = planFor(goodEnv({ FB_AD_ACCOUNT_ID: good }), {
      only: ['ads/read-surface'],
    });
    assert.ok(!hasProblem(p, /FB_AD_ACCOUNT_ID/), good);
  }
  for (const bad of ['act-123', 'ACT_123', 'act_12a', 'act_']) {
    const p = planFor(goodEnv({ FB_AD_ACCOUNT_ID: bad }), { only: ['ads/read-surface'] });
    assert.ok(hasProblem(p, /FB_AD_ACCOUNT_ID/), bad);
  }
});

test('a Reel outside FB_MEDIA_DIR is a problem for a selected Reel smoke', (t) => {
  const { dir } = mediaFixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'smoke-plan-out-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const stray = join(outside, 'probe.mp4');
  writeFileSync(stray, 'x');

  const p = planFor(goodEnv({ FB_MEDIA_DIR: dir, FB_SMOKE_REEL_PATH: stray }), {
    only: ['reels/create-and-status'],
  });
  assert.equal(p.runnable, false);
  assert.ok(
    hasProblem(p, /FB_SMOKE_REEL_PATH.*FB_MEDIA_DIR|FB_MEDIA_DIR.*FB_SMOKE_REEL_PATH/),
  );
});

test('the draft Reel lands in the left-behind list when its smoke runs', (t) => {
  const { dir, reel } = mediaFixture(t);
  const p = planFor(goodEnv({ FB_MEDIA_DIR: dir, FB_SMOKE_REEL_PATH: reel }), {
    only: ['reels/create-and-status'],
  });
  assert.deepEqual(p.problems, []);
  assert.equal(rowOf(p, 'reels/create-and-status').status, 'run');
  assert.deepEqual(
    p.leftBehind.map((entry) => entry.id),
    ['reels/create-and-status'],
  );
  assert.equal(p.command, 'FB_SMOKE=1 npm run smoke -- --only reels/create-and-status');
});

test('--keep turns everything a running smoke creates into a leave-behind', () => {
  const p = planFor(goodEnv(), { only: ['posts/publish-and-delete'], keep: true });
  assert.ok(p.leftBehind.some((entry) => /--keep/.test(entry.item)));
});

test('budget smokes are skipped with the opt-in reason; filtered ones say why', () => {
  const p = planFor(goodEnv());
  const reel = rowOf(p, 'reels/create-and-status');
  assert.equal(reel.status, 'skip');
  assert.match(reel.reason, /include-budget/);
  assert.deepEqual(p.leftBehind, [], 'a skipped smoke leaves nothing');

  const only = planFor(goodEnv(), { only: ['core/identity'] });
  assert.match(rowOf(only, 'posts/publish-and-delete').reason, /--only/);
  const phase = planFor(goodEnv(), { phases: [0] });
  assert.match(rowOf(phase, 'posts/publish-and-delete').reason, /phase/);
});

test('a selected smoke missing a required variable is BLOCKED and not runnable', () => {
  const env = goodEnv();
  delete env.FB_CONFIRM_TOKEN;
  const p = planFor(env);
  const row = rowOf(p, 'posts/publish-and-delete');
  assert.equal(row.status, 'blocked');
  assert.match(row.reason, /FB_CONFIRM_TOKEN/);
  assert.equal(p.runnable, false);
});

test('a malformed value only an unselected smoke reads is a warning, not a problem', () => {
  const p = planFor(goodEnv({ FB_AD_ACCOUNT_ID: 'act-123' }));
  assert.equal(p.runnable, true);
  assert.ok(p.warnings.some((w) => /FB_AD_ACCOUNT_ID/.test(w)));
});

test('an unbuilt server and an unknown --only id are problems', () => {
  const p = planFor(goodEnv(), {
    only: ['does/not-exist'],
    serverPath: join(REPO_ROOT, 'no-such-dir', 'index.js'),
  });
  assert.equal(p.runnable, false);
  assert.ok(hasProblem(p, /npm run build/));
  assert.ok(hasProblem(p, /does\/not-exist/));
});

// --- the printed plan --------------------------------------------------------

test('the printed plan never contains a token value', () => {
  const env = goodEnv({
    FB_SMOKE_TEST_PAGE_TOKEN: TEST_TOKEN,
    FB_SMOKE_PAGE_TOKEN: `Bearer ${SYSTEM_TOKEN}`,
  });
  for (const p of [planFor(env), planFor(env, { includeBudget: true, keep: true })]) {
    const text = plan.formatPlan(p, env);
    assert.doesNotMatch(text, /SECRET/);
    assert.match(text, /set \(hidden\)/);
  }
});

test('the printed plan shows creates, cleanup, leave-behinds and the verdict', (t) => {
  const { dir, reel } = mediaFixture(t);
  const env = goodEnv({ FB_MEDIA_DIR: dir, FB_SMOKE_REEL_PATH: reel });
  const text = plan.formatPlan(
    planFor(env, { only: ['posts/publish-and-delete', 'reels/create-and-status'] }),
    env,
  );
  assert.match(text, /create:\s+1 published text post/);
  assert.match(text, /clean up:\s+deletes the post/);
  assert.match(text, /LEAVE:\s+the DRAFT Reel/);
  assert.match(text, /Left on the real Page after this run/);
  assert.match(text, /Result: runnable/);

  const refused = plan.formatPlan(planFor({}), {});
  assert.match(refused, /Result: NOT runnable/);
});

test('--plan is a runner flag, off by default', () => {
  assert.equal(runner.parseCliArgs(['--plan']).plan, true);
  assert.equal(runner.parseCliArgs([]).plan, false);
  assert.notEqual(runner.EXIT.refused, runner.EXIT.ok);
});

test('a stray rehearsal preload is refused cleanly in every mode, never with a stack', () => {
  // The preload fails closed at import when FB_SMOKE_REHEARSAL_GRAPH is missing;
  // `--plan` already explained that, `--list` and a live run printed a stack.
  // Offline: the module load fails before the gate, the registry or any server.
  for (const argv of [['--list'], ['--plan'], []]) {
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'smoke', 'run.mjs'), ...argv],
      {
        env: { PATH: process.env.PATH, FB_SMOKE_REHEARSAL_PRELOAD: '1' },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    const label = argv.join(' ') || '(live)';
    assert.equal(result.status, runner.EXIT.refused, `${label}: ${result.stderr}`);
    assert.match(result.stderr, /FB_SMOKE_REHEARSAL_GRAPH is not set/, label);
    assert.doesNotMatch(result.stderr, /^\s+at /m, `${label} printed a stack`);
    assert.equal(result.stdout, '', label);
    if (argv[0] !== '--plan') {
      assert.equal(result.stderr.trimEnd().split('\n').length, 1, label);
    }
  }
});
