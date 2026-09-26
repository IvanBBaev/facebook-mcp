// Live smoke harness safety gates (`scripts/smoke/`).
//
// The harness is the only code in this repo that talks to the real Graph API
// with a real token, and it deliberately sits outside `tsconfig`'s `rootDir` and
// outside the `build/**/*.test.js` glob so it is never compiled into the
// published package (`scripts/smoke/run.mjs`, header). That exclusion also left
// it with no automated coverage at all: `scripts/gen-metadata.mjs` has
// `src/metadata.test.ts` and `scripts/record-fixture.mjs` has
// `src/record-fixture.test.ts`, but the ~290 KB under `scripts/smoke/` had
// nothing — and it is the one piece whose failure mode is "created artifacts on,
// and then swept, a Page somebody cares about".
//
// So this file imports the harness's pure decision functions the way
// `src/record-fixture.test.ts` imports the recorder, and pins the refusals.
// Nothing here opens a socket, spawns the server, or reads a credential: every
// assertion is about a decision the harness makes BEFORE any of that. The run
// loop, the MCP client and the sweeper are not covered — they need a live
// server — but the gates that decide whether the run may start at all are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This file compiles to `build/smoke-harness.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const smokeFile = (name: string): string =>
  pathToFileURL(join(REPO_ROOT, 'scripts', 'smoke', name)).href;

/** The environment shape the harness reads — `process.env` without the host's. */
type SmokeEnv = Record<string, string | undefined>;

/** What `registerSmoke` accepts; only the fields these tests exercise. */
interface SmokeSpecInput {
  readonly id: string;
  readonly phase: number;
  readonly title: string;
  readonly run: () => Promise<void>;
  readonly page?: 'none' | 'read' | 'test';
  readonly writes?: boolean;
  readonly budget?: string | null;
  readonly packages?: readonly string[];
  readonly requires?: readonly string[];
}

interface RegisteredSmoke {
  readonly id: string;
  readonly page: 'none' | 'read' | 'test';
  readonly requires: readonly string[];
  readonly packages: readonly string[];
}

/** A selection stub for `resolveSmokeEnv`, which reads all four fields. */
function smokeStub(
  id: string,
  page: 'none' | 'read' | 'test',
  requires: readonly string[] = [],
): RegisteredSmoke {
  return { id, page, requires, packages: [] };
}

interface EnvModule {
  readonly SMOKE_GATE_VAR: string;
  readonly SMOKE_ENV: Readonly<Record<string, string>>;
  readonly SmokeConfigError: new (problems: readonly string[]) => Error & {
    problems: readonly string[];
  };
  gateEnabled(env?: SmokeEnv): boolean;
  gateRefusalMessage(): string;
  resolveSmokeEnv(options?: {
    env?: SmokeEnv;
    smokes?: readonly RegisteredSmoke[];
    requireTestPage?: boolean;
    sweepPackages?: readonly string[];
  }): {
    readPageId: string | undefined;
    testPageId: string | undefined;
    sweepEnabled: boolean;
    packages: readonly string[];
    warnings: readonly string[];
    childEnv: Record<string, string>;
  };
}

interface RegistryModule {
  readonly SmokeRegistrationError: new (message: string) => Error;
  registerSmoke(spec: SmokeSpecInput): void;
  resetRegistry(): void;
  listSmokes(): readonly RegisteredSmoke[];
  selectSmokes(options?: {
    only?: readonly string[];
    phases?: readonly number[];
    includeBudget?: boolean;
  }): {
    selected: readonly RegisteredSmoke[];
    skipped: readonly { smoke: RegisteredSmoke; reason: string }[];
  };
}

interface RunnerModule {
  readonly EXIT: Readonly<Record<'ok' | 'failed' | 'refused', number>>;
  parseCliArgs(argv: readonly string[]): {
    list: boolean;
    only: readonly string[];
    phases: readonly number[];
    includeBudget: boolean;
    sweepOnly: boolean;
    keep: boolean;
    serverPath: string;
    timeoutMs: number;
    verbose: boolean;
    help: boolean;
  };
}

interface CoverageModule {
  toolCoverage(input?: { advertised?: readonly string[]; called?: readonly string[] }): {
    total: number;
    exercised: readonly string[];
    uncovered: readonly string[];
    unadvertised: readonly string[];
  };
  formatCoverageLine(coverage: {
    total: number;
    exercised: readonly string[];
    uncovered: readonly string[];
    unadvertised: readonly string[];
  }): string;
}

const env = (await import(smokeFile('env.mjs'))) as EnvModule;
const registry = (await import(smokeFile('registry.mjs'))) as RegistryModule;
// Importing the runner must not RUN the runner. `parseCliArgs` is exported with
// the comment "so it can be exercised in isolation", and until the entry-point
// guard existed that was not achievable: `main()` was called at module scope, so
// this import alone spawned a run (here: the gate refusal, plus `process.exitCode
// = 2`, which fails the whole suite whatever the assertions say).
const runner = (await import(smokeFile('run.mjs'))) as RunnerModule;
const coverage = (await import(smokeFile('coverage.mjs'))) as CoverageModule;

/** A token that satisfies the credential check without resembling a real one. */
const FAKE_SYSTEM_TOKEN = 'not-a-real-token';

/** Register a smoke with just enough shape to drive a selection decision. */
function fakeSmoke(spec: Partial<SmokeSpecInput> & { id: string }): void {
  registry.registerSmoke({
    phase: 1,
    title: `fake smoke ${spec.id}`,
    run: () => Promise.resolve(),
    ...spec,
  });
}

/** The problem list off a refusal, or a failure naming what was thrown instead. */
function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof env.SmokeConfigError) return err.problems;
    throw err;
  }
  assert.fail('expected the harness to refuse, but it resolved');
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('the smoke gate opens for exactly "1" and for nothing else that looks truthy', () => {
  assert.equal(env.gateEnabled({ FB_SMOKE: '1' }), true);

  // Every one of these is truthy as a JS string. A gate written as
  // `if (env.FB_SMOKE)` would open on all of them, and "FB_SMOKE=0" or
  // "FB_SMOKE=false" is precisely how somebody expresses "no".
  for (const value of ['0', 'false', 'no', 'true', 'yes', 'on', ' 1', '1 ', '']) {
    assert.equal(
      env.gateEnabled({ FB_SMOKE: value }),
      false,
      `FB_SMOKE=${JSON.stringify(value)} must not open the gate`,
    );
  }
  assert.equal(env.gateEnabled({}), false, 'an unset gate is a closed gate');
});

test('the gate refusal names the variable and the exact command to run', () => {
  const message = env.gateRefusalMessage();
  assert.match(message, /FB_SMOKE=1/);
  assert.match(message, /no network call/);
});

// ---------------------------------------------------------------------------
// Which Page the writes land on — the expensive mistake
// ---------------------------------------------------------------------------

test('a write smoke refuses when no dedicated test Page is configured', () => {
  const problems = problemsOf(() =>
    env.resolveSmokeEnv({
      env: { FB_SYSTEM_TOKEN: FAKE_SYSTEM_TOKEN, FB_PAGE_ID: '111' },
      smokes: [smokeStub('fake/write', 'test')],
    }),
  );
  // The point is not just that it refuses — it is that FB_PAGE_ID, which IS set
  // here, is not quietly accepted as a stand-in.
  assert.ok(
    problems.some((p) => p.includes('FB_SMOKE_TEST_PAGE_ID')),
    `expected a test-Page problem, got: ${problems.join(' | ')}`,
  );
  assert.ok(
    problems.some((p) => p.includes('no fallback to FB_PAGE_ID')),
    'the refusal must say the fallback is deliberate',
  );
});

test('the test Page may not be the read Page', () => {
  const problems = problemsOf(() =>
    env.resolveSmokeEnv({
      env: {
        FB_SYSTEM_TOKEN: FAKE_SYSTEM_TOKEN,
        FB_SMOKE_PAGE_ID: '222',
        FB_SMOKE_TEST_PAGE_ID: '222',
      },
      smokes: [smokeStub('fake/write', 'test')],
    }),
  );
  assert.ok(
    problems.some((p) => p.includes('the same Page')),
    `expected a same-Page refusal, got: ${problems.join(' | ')}`,
  );
});

test('the test Page may not be the server default Page, even when a different read Page is set', () => {
  // The one Page an operator provably cares about is FB_PAGE_ID: it is what
  // their day-to-day server configuration points at. Setting FB_SMOKE_PAGE_ID
  // to some third Page (to read one with real content) moves the read Page away
  // from FB_PAGE_ID, so a guard that only compares the test Page against the
  // READ Page stops covering the production Page entirely — and the sweeper
  // deletes marked artifacts on whatever the test Page turns out to be.
  const problems = problemsOf(() =>
    env.resolveSmokeEnv({
      env: {
        FB_SYSTEM_TOKEN: FAKE_SYSTEM_TOKEN,
        FB_PAGE_ID: '333',
        FB_SMOKE_PAGE_ID: '444',
        FB_SMOKE_TEST_PAGE_ID: '333',
      },
      smokes: [smokeStub('fake/write', 'test')],
    }),
  );
  assert.ok(
    problems.some((p) => p.includes('FB_PAGE_ID')),
    `expected the production Page to be refused as a test Page, got: ${problems.join(' | ')}`,
  );
});

test('a distinct test Page, read Page and default Page is accepted', () => {
  const resolved = env.resolveSmokeEnv({
    env: {
      FB_SYSTEM_TOKEN: FAKE_SYSTEM_TOKEN,
      FB_PAGE_ID: '333',
      FB_SMOKE_PAGE_ID: '444',
      FB_SMOKE_TEST_PAGE_ID: '555',
      FB_CONFIRM_TOKEN: 'confirm',
    },
    smokes: [smokeStub('fake/write', 'test')],
  });
  assert.equal(resolved.testPageId, '555');
  assert.equal(resolved.readPageId, '444');
  assert.equal(resolved.sweepEnabled, true);
});

// ---------------------------------------------------------------------------
// Refusals report everything at once
// ---------------------------------------------------------------------------

test('a refusal reports every problem at once, not just the first', () => {
  const problems = problemsOf(() =>
    env.resolveSmokeEnv({
      // No credential AND no test Page: an operator who fixes one and re-runs
      // only to hit the other has been made to pay twice for one mistake.
      env: {},
      smokes: [smokeStub('fake/write', 'test')],
    }),
  );
  assert.ok(
    problems.length >= 2,
    `expected several problems, got: ${problems.join(' | ')}`,
  );
  assert.ok(problems.some((p) => p.includes('no credential')));
  assert.ok(problems.some((p) => p.includes('FB_SMOKE_TEST_PAGE_ID')));
});

test('FB_PAGE_TOKEN alone covers only FB_PAGE_ID, so it cannot reach a test Page', () => {
  const problems = problemsOf(() =>
    env.resolveSmokeEnv({
      env: {
        FB_PAGE_TOKEN: 'page-token',
        FB_PAGE_ID: '333',
        FB_SMOKE_TEST_PAGE_ID: '555',
      },
      smokes: [smokeStub('fake/write', 'test')],
    }),
  );
  assert.ok(
    problems.some((p) => p.includes('no token path for the test Page')),
    `expected a token-path problem, got: ${problems.join(' | ')}`,
  );
});

// ---------------------------------------------------------------------------
// Selection: what runs by default, and what must be asked for
// ---------------------------------------------------------------------------

test('a budget-consuming smoke is skipped by default and named in --only to opt in', () => {
  registry.resetRegistry();
  fakeSmoke({ id: 'fake/free' });
  fakeSmoke({ id: 'fake/costly', budget: 'ads', page: 'none' });

  const byDefault = registry.selectSmokes();
  assert.deepEqual(
    byDefault.selected.map((s) => s.id),
    ['fake/free'],
    'a quota-consuming smoke must never run just because it exists',
  );
  assert.equal(byDefault.skipped.length, 1);
  assert.match(byDefault.skipped[0]?.reason ?? '', /--include-budget|--only/);

  // Registration order is not selection order: the registry sorts by phase and
  // then by id, so the run is reproducible whatever order the files load in.
  assert.deepEqual(
    registry.selectSmokes({ includeBudget: true }).selected.map((s) => s.id),
    ['fake/costly', 'fake/free'],
  );
  // Naming it explicitly is itself the opt-in — no second flag required.
  assert.deepEqual(
    registry.selectSmokes({ only: ['fake/costly'] }).selected.map((s) => s.id),
    ['fake/costly'],
  );
});

test('--only wins over --phase rather than intersecting with it', () => {
  registry.resetRegistry();
  fakeSmoke({ id: 'fake/early', phase: 1 });
  fakeSmoke({ id: 'fake/late', phase: 3 });

  // Pinning the behaviour, not endorsing it: `selectSmokes` computes the phase
  // filter and then discards it when `only` is non-empty, so asking for a
  // phase-3 smoke under `--phase 1` runs it anyway. That is the documented
  // contract in `registry.mjs` ("exactly those ids"), and an explicit id is a
  // stronger statement of intent than a phase sweep — but it is silent, so the
  // test exists to make any future change to it deliberate.
  assert.deepEqual(
    registry.selectSmokes({ only: ['fake/late'], phases: [1] }).selected.map((s) => s.id),
    ['fake/late'],
  );
  assert.deepEqual(
    registry.selectSmokes({ phases: [1] }).selected.map((s) => s.id),
    ['fake/early'],
  );
});

test('an unknown smoke id is refused rather than silently selecting nothing', () => {
  registry.resetRegistry();
  fakeSmoke({ id: 'fake/free' });
  assert.throws(
    () => registry.selectSmokes({ only: ['fake/typo'] }),
    (err: unknown) =>
      err instanceof registry.SmokeRegistrationError &&
      /unknown smoke id/.test(err.message),
  );
});

test('a smoke that writes may not declare any Page but the test Page', () => {
  registry.resetRegistry();
  // The registry, not the run loop, is where this is enforced — so a smoke file
  // that gets this wrong fails at import time rather than at delete time.
  assert.throws(
    () => fakeSmoke({ id: 'fake/bad', writes: true, page: 'read' }),
    (err: unknown) => err instanceof registry.SmokeRegistrationError,
  );
  assert.throws(
    () => fakeSmoke({ id: 'fake/bad2', writes: true, page: 'none' }),
    (err: unknown) => err instanceof registry.SmokeRegistrationError,
  );
  // `writes: true` with no explicit page defaults to the test Page.
  fakeSmoke({ id: 'fake/good', writes: true });
  assert.equal(registry.listSmokes()[0]?.page, 'test');
});

// ---------------------------------------------------------------------------
// The environment the child server is actually spawned with
// ---------------------------------------------------------------------------

test('the child server is forced into plan mode over stdio, whatever the operator configured', () => {
  const resolved = env.resolveSmokeEnv({
    env: {
      FB_SYSTEM_TOKEN: FAKE_SYSTEM_TOKEN,
      FB_SMOKE_PAGE_ID: '444',
      FB_SMOKE_TEST_PAGE_ID: '555',
      FB_CONFIRM_TOKEN: 'confirm',
      // An operator whose own shell says "apply everything over HTTP" must not
      // have that inherited by a harness that is about to write to a Page.
      FB_WRITE_MODE: 'apply',
      FB_TRANSPORT: 'http',
    },
    smokes: [smokeStub('fake/write', 'test')],
  });
  assert.equal(resolved.childEnv.FB_WRITE_MODE, 'plan');
  assert.equal(resolved.childEnv.FB_TRANSPORT, 'stdio');
});

test('an empty package declaration narrows to the core package instead of widening', () => {
  const resolved = env.resolveSmokeEnv({
    env: { FB_SYSTEM_TOKEN: FAKE_SYSTEM_TOKEN, FB_SMOKE_PAGE_ID: '444' },
    smokes: [smokeStub('fake/read', 'read')],
  });
  // `core` here is the reserved PROFILE token, which expands to the six default
  // packages — so selecting it and denying everything is what actually yields
  // the minimal surface. The deny list is the half that does the narrowing.
  assert.deepEqual(resolved.packages, ['core']);
  assert.ok(
    (resolved.childEnv.FB_PACKAGES_DENY ?? '').length > 0,
    'an empty declaration must deny, not just select',
  );
});

// ---------------------------------------------------------------------------
// The CLI surface
// ---------------------------------------------------------------------------

test('importing the runner does not start a run', () => {
  // The assertion IS the import above; this test names the invariant so a
  // regression reads as "importing the runner started a run" rather than as
  // fourteen unrelated failures. `process.exitCode` is the observable: `main()`
  // sets it on every path it takes.
  assert.equal(process.exitCode ?? 0, 0, 'the runner must not have run');
  assert.equal(runner.EXIT.refused, 2);
});

test('--only and --phase accept both comma lists and repetition', () => {
  const args = runner.parseCliArgs([
    '--only',
    'a/one, a/two',
    '--only',
    'b/three',
    '--phase',
    '1,2',
    '--phase',
    '3',
  ]);
  // A smoke id is never allowed to arrive with surrounding whitespace: it is
  // matched against the registry by exact string, and a stray space would come
  // back as "unknown smoke id" for an id the operator can see in --list.
  assert.deepEqual(args.only, ['a/one', 'a/two', 'b/three']);
  assert.deepEqual(args.phases, [1, 2, 3]);
});

test('a non-integer phase and a non-positive timeout are refused, not coerced', () => {
  for (const bad of ['one', '1.5', '']) {
    assert.throws(
      () => runner.parseCliArgs(['--phase', bad]),
      (err: unknown) => err instanceof registry.SmokeRegistrationError,
      `--phase ${JSON.stringify(bad)} must be refused`,
    );
  }
  // `--timeout=<v>`, not `--timeout <v>`: a leading `-` in the value makes
  // node's own parseArgs reject it as a missing option value first, which is a
  // refusal too but not this one.
  for (const bad of ['0', '-1', 'soon']) {
    assert.throws(
      () => runner.parseCliArgs([`--timeout=${bad}`]),
      (err: unknown) => err instanceof registry.SmokeRegistrationError,
      `--timeout ${JSON.stringify(bad)} must be refused`,
    );
  }
  // An empty `--only` must not fall through to "no narrowing", which would run
  // the whole default set against a live Page.
  assert.throws(
    () => runner.parseCliArgs(['--only', '  ']),
    (err: unknown) => err instanceof registry.SmokeRegistrationError,
  );
});

test('the runner defaults to the built server and every switch off', () => {
  const args = runner.parseCliArgs([]);
  assert.equal(args.includeBudget, false, 'quota-consuming smokes are opt-in');
  assert.equal(args.keep, false, 'the end sweep runs unless asked not to');
  assert.equal(args.sweepOnly, false);
  assert.equal(args.list, false);
  assert.deepEqual(args.only, []);
  assert.deepEqual(args.phases, []);
  assert.match(args.serverPath, /build[/\\]index\.js$/);
  assert.ok(args.timeoutMs > 0);
});

test('an unknown flag is refused rather than ignored', () => {
  // `allowPositionals: false` plus a closed option list: a typo'd `--includebudget`
  // must not resolve to "run the default set", which would look like a pass.
  assert.throws(() => runner.parseCliArgs(['--includebudget']));
  assert.throws(() => runner.parseCliArgs(['some-positional']));
});

// ---------------------------------------------------------------------------
// Tool coverage — what the run is actually evidence for
// ---------------------------------------------------------------------------

test('a tool the session advertised but never answered is reported, not counted as covered', () => {
  const report = coverage.toolCoverage({
    advertised: ['facebook_whoami', 'facebook_list_pages', 'facebook_usage'],
    called: ['facebook_whoami'],
  });
  assert.equal(report.total, 3);
  assert.deepEqual(report.exercised, ['facebook_whoami']);
  // The names, not just the count: an operator reading the summary is deciding
  // whether the gap is the selection they asked for or a smoke that quietly
  // stopped calling something, and a bare ratio cannot tell them apart.
  assert.deepEqual(report.uncovered, ['facebook_list_pages', 'facebook_usage']);
  assert.deepEqual(report.unadvertised, []);
});

test('a tool called but never advertised is surfaced instead of absorbed', () => {
  // Every such call comes back "unknown tool", which reads like an ordinary tool
  // error inside a smoke. It is not: the smoke is calling a tool this package
  // selection does not load, so the scenario it claims to cover never ran.
  const report = coverage.toolCoverage({
    advertised: ['facebook_whoami'],
    called: ['facebook_whoami', 'facebook_delete_post'],
  });
  assert.deepEqual(report.unadvertised, ['facebook_delete_post']);
  assert.deepEqual(report.uncovered, []);
  assert.equal(report.total, 1, 'the denominator is what the SERVER advertised');
});

test('coverage counts distinct tools, not calls, and tolerates an empty run', () => {
  const repeated = coverage.toolCoverage({
    advertised: ['facebook_whoami', 'facebook_usage'],
    called: ['facebook_whoami', 'facebook_whoami', 'facebook_whoami'],
  });
  assert.equal(repeated.exercised.length, 1, 'three calls to one tool cover one tool');
  const nothing = coverage.toolCoverage();
  assert.equal(nothing.total, 0);
  assert.deepEqual(nothing.uncovered, []);
});

test('the summary line names a full house and never claims one it cannot prove', () => {
  const complete = coverage.formatCoverageLine(
    coverage.toolCoverage({
      advertised: ['facebook_whoami'],
      called: ['facebook_whoami'],
    }),
  );
  assert.match(complete, /1 of 1 advertised tool\(s\) exercised/);
  assert.match(complete, /every advertised tool was called/);

  const partial = coverage.formatCoverageLine(
    coverage.toolCoverage({
      advertised: ['facebook_whoami', 'facebook_usage'],
      called: ['facebook_whoami'],
    }),
  );
  assert.match(partial, /never called: facebook_usage/);
  assert.doesNotMatch(partial, /every advertised tool/);

  // A session with no tools at all must not render as "0 of 0 exercised", which
  // reads like a clean sweep of a surface that was never there.
  const empty = coverage.formatCoverageLine(coverage.toolCoverage());
  assert.match(empty, /no tools were advertised/);
});

test('a long uncovered list is truncated with a count rather than printed whole', () => {
  const advertised = Array.from({ length: 20 }, (_, i) => `facebook_tool_${String(i)}`);
  const line = coverage.formatCoverageLine(
    coverage.toolCoverage({ advertised, called: [] }),
  );
  assert.match(line, /\+8 more/, 'twelve names are shown and the rest are counted');
  assert.match(line, /0 of 20 advertised tool\(s\) exercised/);
});
