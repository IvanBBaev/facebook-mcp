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

  if (testPageId !== undefined && readPageId !== undefined && testPageId === readPageId) {
    problems.push(
      `${SMOKE_ENV.testPageId} and the read Page are the same Page (${testPageId}) — the sweeper ` +
        'deletes marked artifacts on the test Page, so it must never be a Page you care about',
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

  for (const smoke of smokes) {
    const missing = smoke.requires.filter((name) => nonEmpty(env, name) === undefined);
    if (missing.length > 0) {
      problems.push(`smoke "${smoke.id}" requires: ${missing.join(', ')}`);
    }
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

  // Not a refusal: a run without an operator confirmation token is still useful
  // (every reversible write is exercised end to end). It just cannot delete what
  // it created, so say so up front rather than letting the sweep explain it at
  // the end. See the "Confirmation" section of README.md.
  if (sweepEnabled && nonEmpty(env, 'FB_CONFIRM_TOKEN') === undefined) {
    warnings.push(
      'FB_CONFIRM_TOKEN is not set — irreversible applies (deleting posts and comments) ' +
        'will be denied, so the sweep will report every created artifact as a leak and the ' +
        'run will exit 1. Set it to the same value the server is configured with.',
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
  if (packages.size === 0) {
    // `core` is a PROFILE token: it expands to the six default packages.
    packages.add('core');
  }

  return {
    readPageId,
    testPageId,
    sweepEnabled,
    packages: [...packages],
    warnings,
    childEnv: buildChildEnv({ env, readPageId, testPageId, packages: [...packages] }),
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
 *  - `FB_PROFILE_SMOKETEST_*` / `FB_PROFILE_SMOKEREAD_*` — the two Pages, as
 *    named profiles. Raw Page IDs only resolve when they are already configured,
 *    and a named profile key is the only unambiguous way to address a Page.
 *
 * Everything else the operator set is inherited verbatim. `FB_CONFIRM_TOKEN` is
 * the one that matters for cleanup: the child needs it to accept an irreversible
 * apply, and the harness forwards the same value as `confirm_token` (client.mjs).
 * The harness never invents one — the approval has to come from a human.
 */
export function buildChildEnv({ env, readPageId, testPageId, packages }) {
  const child = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      child[key] = value;
    }
  }

  child.FB_TRANSPORT = 'stdio';
  child.FB_WRITE_MODE = 'plan';
  child.FB_TOOL_PACKAGES = packages.join(',');
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
