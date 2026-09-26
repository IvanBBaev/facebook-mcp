// The environment contract of the live smoke harness.
//
// Nothing in this file performs I/O. It answers two questions, both BEFORE any
// network call and before the MCP server is even spawned:
//
//   1. Is the harness allowed to run at all? (`FB_SMOKE=1` — doc 08 / C13.)
//   2. Is the configuration complete AND safe for the selected smokes?
//
// Question 2 is answered by collecting EVERY problem and reporting them
// together, rather than failing on the first one — the same discipline the
// server's own settings loader uses. A run that refuses here has touched
// nothing: no Graph API call, no child process.
//
// Write safety (task constraint, doc 08 "Smoke Safety Protocol"):
//   - writes only ever target the Page in `FB_SMOKE_TEST_PAGE_ID`;
//   - that variable has NO fallback — not `FB_PAGE_ID`, not the first profile.
//     If it is missing, write smokes and the sweeper refuse to run;
//   - the test Page and the read Page must be different Pages.

/** The gate variable. Anything other than exactly "1" means "do not run". */
export const SMOKE_GATE_VAR = 'FB_SMOKE';

/**
 * The server's out-of-band operator approval for an `irreversible` apply. Not a
 * harness variable — the harness only forwards the value the operator already
 * configured for the server — but the harness has to reason about it, because a
 * smoke that creates an artifact and then deletes it cannot finish without one.
 */
export const CONFIRM_TOKEN_VAR = 'FB_CONFIRM_TOKEN';

/** Profile keys the harness injects into the child server's environment. */
export const TEST_PROFILE = 'smoketest';
export const READ_PROFILE = 'smokeread';

/**
 * Env var names of the harness itself (the server never sees these; it sees the
 * `FB_PROFILE_*` variables the runner derives from them).
 */
export const SMOKE_ENV = Object.freeze({
  gate: SMOKE_GATE_VAR,
  readPageId: 'FB_SMOKE_PAGE_ID',
  readPageToken: 'FB_SMOKE_PAGE_TOKEN',
  testPageId: 'FB_SMOKE_TEST_PAGE_ID',
  testPageToken: 'FB_SMOKE_TEST_PAGE_TOKEN',
});

/** Raised when the harness refuses to run. Carries every problem found. */
export class SmokeConfigError extends Error {
  name = 'SmokeConfigError';

  constructor(problems) {
    super(`refusing to run:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

/** True only for `FB_SMOKE=1`. Deliberately not "truthy". */
export function gateEnabled(env = process.env) {
  return env[SMOKE_GATE_VAR] === '1';
}

/** The message shown when the gate is off — it must say exactly what to do. */
export function gateRefusalMessage() {
  return (
    `${SMOKE_GATE_VAR} is not set to "1", so the live smoke harness refused to run.\n` +
    'These smokes talk to the real Graph API with real credentials and create real\n' +
    'artifacts on the configured test Page. Nothing was executed and no network call\n' +
    `was made. To run them deliberately:  ${SMOKE_GATE_VAR}=1 npm run smoke`
  );
}

function nonEmpty(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Can the server obtain a Page token for `pageId`?
 *  - a base token (system/user) can derive one;
 *  - an explicit per-profile override always works;
 *  - `FB_PAGE_TOKEN` works only for the default Page (`FB_PAGE_ID`).
 */
function tokenPathFor(env, pageId, overrideVar) {
  if (nonEmpty(env, overrideVar) !== undefined) return 'override';
  if (nonEmpty(env, 'FB_SYSTEM_TOKEN') !== undefined) return 'system';
  if (nonEmpty(env, 'FB_ACCESS_TOKEN') !== undefined) return 'user';
  if (
    nonEmpty(env, 'FB_PAGE_TOKEN') !== undefined &&
    nonEmpty(env, 'FB_PAGE_ID') === pageId
  ) {
    return 'page';
  }
  return undefined;
}

/**
 * Validate the environment for a concrete selection of smokes and build the
 * environment the child server will be spawned with.
 *
 * `requireTestPage` makes `FB_SMOKE_TEST_PAGE_ID` mandatory (a write smoke is
 * selected, or `--sweep-only` was asked for). Independently of that, the sweep
 * RUNS whenever a test Page is configured: sweeping is cheap, and a read-only
 * run on a machine that has a test Page is a free chance to clear leftovers.
 *
 * @returns {{
 *   readPageId: string|undefined,
 *   testPageId: string|undefined,
 *   sweepEnabled: boolean,
 *   packages: string[],
 *   childEnv: Record<string,string>,
 *   warnings: string[],
 * }}
 * @throws {SmokeConfigError} with every problem found, when the run must not start.
 */
export function resolveSmokeEnv({
  env = process.env,
  smokes = [],
  requireTestPage = false,
  sweepPackages = [],
} = {}) {
  const problems = [];
  const warnings = [];

  const needsTestPage = requireTestPage || smokes.some((smoke) => smoke.page === 'test');
  const needsReadPage = smokes.some((smoke) => smoke.page === 'read');

  if (
    nonEmpty(env, 'FB_SYSTEM_TOKEN') === undefined &&
    nonEmpty(env, 'FB_ACCESS_TOKEN') === undefined &&
    nonEmpty(env, 'FB_PAGE_TOKEN') === undefined
  ) {
    problems.push(
      'no credential: set FB_SYSTEM_TOKEN (preferred) or FB_ACCESS_TOKEN so the server can derive Page tokens',
    );
  }

  const testPageId = nonEmpty(env, SMOKE_ENV.testPageId);
  if (needsTestPage && testPageId === undefined) {
    problems.push(
      `${SMOKE_ENV.testPageId} is not set — write smokes and the sweeper target the dedicated ` +
        'test Page and there is deliberately no fallback to FB_PAGE_ID',
    );
  }

  const readPageId = nonEmpty(env, SMOKE_ENV.readPageId) ?? nonEmpty(env, 'FB_PAGE_ID');
  if (needsReadPage && readPageId === undefined) {
    problems.push(
      `${SMOKE_ENV.readPageId} (or FB_PAGE_ID) is not set — the selected read-only smokes need a Page to read`,
    );
  }

  // The test Page must be a Page nobody cares about: write smokes create
  // artifacts on it and the sweeper then DELETES every marked artifact it finds
  // there, including leftovers from runs it knows nothing about. Two Pages are
  // provably cared about — the one the smokes read from, and FB_PAGE_ID, the
  // default the operator's own server is configured with. Comparing only against
  // the read Page covers the second one by accident (readPageId falls back to
  // FB_PAGE_ID) and stops covering it the moment FB_SMOKE_PAGE_ID is set to a
  // third Page — which is exactly what an operator reaches for when they want to
  // read a Page with real content. So both are checked, and the message names
  // which collision it is.
  const defaultPageId = nonEmpty(env, 'FB_PAGE_ID');
  let collision;
  if (testPageId !== undefined && readPageId !== undefined && testPageId === readPageId) {
    collision = 'the read Page';
  } else if (
    testPageId !== undefined &&
    defaultPageId !== undefined &&
    testPageId === defaultPageId
  ) {
    collision = "FB_PAGE_ID, the server's default Page";
  }
  if (collision !== undefined) {
    problems.push(
      `${SMOKE_ENV.testPageId} and ${collision} are the same Page (${testPageId}) — the ` +
        'sweeper deletes marked artifacts on the test Page, so it must never be a Page you ' +
        'care about',
    );
  }

  if (needsTestPage && testPageId !== undefined) {
    const path = tokenPathFor(env, testPageId, SMOKE_ENV.testPageToken);
    if (path === undefined) {
      problems.push(
        `no token path for the test Page: set ${SMOKE_ENV.testPageToken}, or a base token ` +
          '(FB_SYSTEM_TOKEN / FB_ACCESS_TOKEN) that can derive it (FB_PAGE_TOKEN only covers FB_PAGE_ID)',
      );
    }
  }
  if (needsReadPage && readPageId !== undefined) {
    const path = tokenPathFor(env, readPageId, SMOKE_ENV.readPageToken);
    if (path === undefined) {
      problems.push(
        `no token path for the read Page: set ${SMOKE_ENV.readPageToken}, or a base token ` +
          '(FB_SYSTEM_TOKEN / FB_ACCESS_TOKEN) that can derive it (FB_PAGE_TOKEN only covers FB_PAGE_ID)',
      );
    }
  }

  let confirmTokenRequired = false;
  for (const smoke of smokes) {
    const missing = smoke.requires.filter((name) => nonEmpty(env, name) === undefined);
    if (missing.length > 0) {
      problems.push(`smoke "${smoke.id}" requires: ${missing.join(', ')}`);
      confirmTokenRequired ||= missing.includes(CONFIRM_TOKEN_VAR);
    }
  }
  // A missing confirmation token is the single most common reason a first run
  // refuses — every write smoke deletes what it created, and deleting is an
  // `irreversible` apply — so it gets a sentence instead of a bare variable
  // name in a list. Note that this IS a refusal: those smokes declared the
  // variable in `requires`, and a smoke that cannot clean up after itself must
  // not start. The warning further down covers the other case (a selection that
  // creates nothing, where the token is optional).
  if (confirmTokenRequired) {
    problems.push(
      `${CONFIRM_TOKEN_VAR} is the out-of-band approval the server demands before an ` +
        'irreversible apply (deleting a post or a comment). The smokes listed above create an ' +
        'artifact and then delete it, so without it they would refuse the cleanup and leave ' +
        'every artifact on the test Page. Set it to the same value the server is configured ' +
        'with, or narrow the run to smokes that do not need it (--list shows what each requires)',
    );
  }

  if (problems.length > 0) {
    throw new SmokeConfigError(problems);
  }

  if (nonEmpty(env, 'FB_SMOKE_PAGE_ID') === undefined && readPageId !== undefined) {
    warnings.push(
      `${SMOKE_ENV.readPageId} is not set — read smokes fall back to FB_PAGE_ID (${readPageId})`,
    );
  }

  const sweepEnabled = testPageId !== undefined;

  // Reachable only when NO selected smoke listed the token in `requires` — a
  // read-only selection, or `--sweep-only`. Such a run creates nothing, so the
  // missing token is not a refusal (the loop above already refused for the
  // smokes that do need it); it only stops the sweep from REMOVING what an
  // earlier run left behind. Saying so here beats letting the sweep discover it
  // at the end. See the "Confirmation" section of README.md.
  if (sweepEnabled && nonEmpty(env, CONFIRM_TOKEN_VAR) === undefined) {
    warnings.push(
      `${CONFIRM_TOKEN_VAR} is not set — deleting a post or a comment is an irreversible ` +
        'apply and the server will deny it without the token, so the sweep can REPORT a ' +
        'leftover from an earlier run but cannot remove it, and the run then exits 1. Set it ' +
        'to the same value the server is configured with.',
    );
  }

  // Only what the selected smokes (and the sweep) declared. The registry always
  // forces the `core` package on, so it never has to be listed — and keeping the
  // surface minimal means a smoke that forgets to declare a package it uses
  // fails loudly with "unknown tool" instead of passing by accident.
  const packages = new Set();
  for (const smoke of smokes) {
    for (const name of smoke.packages) {
      packages.add(name);
    }
  }
  if (sweepEnabled) {
    for (const name of sweepPackages) {
      packages.add(name);
    }
  }
  // An empty declaration has to NARROW, not widen. `core` looks like the obvious
  // fallback and is the opposite of one: it is a reserved PROFILE token that
  // wins the shared namespace and expands to the six default packages
  // (`src/mcp/packages.ts` — `PROFILES.core = DEFAULT_PROFILE_PACKAGES`), i.e.
  // the widest surface short of `ads`. There is no token that expands to the
  // `core` PACKAGE alone — but that package is always-on and SURVIVES a deny
  // (`src/mcp/registry.ts`: `selected.add(ALWAYS_ON)` runs after the deny
  // filter), so "select the core profile, then deny everything" resolves to
  // exactly one package. That is the minimal surface, and it keeps the
  // invariant above true.
  //
  // Reachable on `--only core/identity` with no test Page configured: that
  // smoke declares no packages because every tool it calls is in `core`.
  const denyEverythingButCore = packages.size === 0;
  if (denyEverythingButCore) {
    packages.add('core');
  }

  return {
    readPageId,
    testPageId,
    sweepEnabled,
    packages: [...packages],
    warnings,
    childEnv: buildChildEnv({
      env,
      readPageId,
      testPageId,
      packages: [...packages],
      denyEverythingButCore,
    }),
  };
}

/**
 * The environment the MCP server child is spawned with. Inherits the operator's
 * own configuration (tokens, API version, HTTP settings) and then forces the
 * bits the harness owns:
 *
 *  - `FB_TRANSPORT=stdio` — the harness always drives the server over stdio;
 *  - `FB_WRITE_MODE=plan` — a belt on top of the braces: with the server in
 *    plan mode nothing mutates unless a call passes `apply:true` AND a
 *    `plan_id` from a preview this harness itself inspected;
 *  - `FB_TOOL_PACKAGES` — only the packages the selected smokes declared;
 *  - `FB_PACKAGES_DENY` / `FB_PACKAGES_READONLY` — forced, never inherited. The
 *    harness owns the exposed tool surface: an operator's day-to-day
 *    `FB_PACKAGES_DENY=posts` would otherwise silently remove a tool a selected
 *    smoke declared. `deny=all` is also how the minimal fallback surface is
 *    expressed, since `core` survives a deny (see `resolveSmokeEnv`);
 *  - `FB_PROFILE_SMOKETEST_*` / `FB_PROFILE_SMOKEREAD_*` — the two Pages, as
 *    named profiles. Raw Page IDs only resolve when they are already configured,
 *    and a named profile key is the only unambiguous way to address a Page.
 *
 * Everything else the operator set is inherited verbatim. `FB_CONFIRM_TOKEN` is
 * the one that matters for cleanup: the child needs it to accept an irreversible
 * apply, and the harness forwards the same value as `confirm_token` (client.mjs).
 * The harness never invents one — the approval has to come from a human.
 */
export function buildChildEnv({
  env,
  readPageId,
  testPageId,
  packages,
  denyEverythingButCore = false,
}) {
  const child = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      child[key] = value;
    }
  }

  child.FB_TRANSPORT = 'stdio';
  child.FB_WRITE_MODE = 'plan';
  child.FB_TOOL_PACKAGES = packages.join(',');
  child.FB_PACKAGES_DENY = denyEverythingButCore ? 'all' : '';
  child.FB_PACKAGES_READONLY = '';
  child.FB_LOG_LEVEL = nonEmpty(env, 'FB_LOG_LEVEL') ?? 'warn';

  if (testPageId !== undefined) {
    child[`FB_PROFILE_${TEST_PROFILE.toUpperCase()}_PAGE_ID`] = testPageId;
    const token = nonEmpty(env, SMOKE_ENV.testPageToken);
    if (token !== undefined) {
      child[`FB_PROFILE_${TEST_PROFILE.toUpperCase()}_TOKEN`] = token;
    }
  }
  if (readPageId !== undefined) {
    child[`FB_PROFILE_${READ_PROFILE.toUpperCase()}_PAGE_ID`] = readPageId;
    const token = nonEmpty(env, SMOKE_ENV.readPageToken);
    if (token !== undefined) {
      child[`FB_PROFILE_${READ_PROFILE.toUpperCase()}_TOKEN`] = token;
    }
  }

  return child;
}
