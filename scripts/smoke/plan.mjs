// `--plan`: the offline dry run of the live smoke harness.
//
// A first live run is the expensive moment to discover a typo: the gate opens,
// the server spawns, and the run refuses on the first problem it trips over —
// or worse, runs and leaves a Reel on the test Page nobody expected. `--plan`
// answers every question an operator has BEFORE that, with no network call and
// no child process:
//
//   1. Is the environment complete, well-formed and safe for this selection?
//      Every problem is collected and printed together: what `resolveSmokeEnv`
//      would refuse on (the same function, so the plan cannot disagree with the
//      run), plus shape checks the run only discovers later (a non-numeric Page
//      id, a `Bearer ` prefix pasted into a token, a Reel outside FB_MEDIA_DIR,
//      a confirmation token the server will ignore) and FB_SMOKE_* names nobody
//      reads, with the closest name that IS read.
//   2. What will the run do? Per smoke: runs / skipped / blocked and why, and —
//      from the `effects` each smoke declares in the registry — what it creates
//      on the real test Page, how it cleans up, and what it leaves behind.
//
// Everything here is pure over its inputs except the few `fs` stat calls that
// check local paths (the server entry point, FB_MEDIA_DIR, FB_SMOKE_REEL_PATH).
// Output goes through `scrub()`, and no token value is ever formatted in the
// first place: a token is reported as "set (hidden)" or by its problem.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { extname, relative, isAbsolute } from 'node:path';

import {
  CONFIRM_TOKEN_VAR,
  SMOKE_ENV,
  SmokeConfigError,
  resolveSmokeEnv,
} from './env.mjs';
import { clip, scrub } from './log.mjs';
import { selectFrom } from './registry.mjs';

/** The server's floor for FB_CONFIRM_TOKEN (MIN_CONFIRM_TOKEN_CHARS, src/core/settings.ts). */
export const MIN_CONFIRM_TOKEN_CHARS = 16;

/** The rehearsal switches (rehearse.mjs, rehearsal/fetch-redirect.mjs, pace.mjs). */
export const REHEARSAL_VARS = Object.freeze([
  'FB_SMOKE_REHEARSAL_PRELOAD',
  'FB_SMOKE_REHEARSAL_GRAPH',
]);

/** Variables the harness reads beyond `SMOKE_ENV`, declared by smokes in `requires`. */
const SMOKE_OPTION_VARS = Object.freeze(['FB_SMOKE_PHOTO_URL', 'FB_SMOKE_REEL_PATH']);

/**
 * Non-FB_SMOKE names a misspelt FB_SMOKE_* variable most likely meant. Only used
 * as suggestion targets — an operator who writes FB_SMOKE_CONFIRM_TOKEN means
 * FB_CONFIRM_TOKEN, and saying so is the whole fix.
 */
const SERVER_VARS = Object.freeze([
  CONFIRM_TOKEN_VAR,
  'FB_MEDIA_DIR',
  'FB_AD_ACCOUNT_ID',
  'FB_PAGE_ID',
  'FB_PAGE_TOKEN',
  'FB_SYSTEM_TOKEN',
  'FB_ACCESS_TOKEN',
]);

/**
 * Names whose nearest neighbour by spelling is the WRONG Page. "read page id" is
 * four edits from FB_SMOKE_TEST_PAGE_ID and seven from FB_SMOKE_PAGE_ID, and a
 * suggestion that swaps the read Page for the write target is worse than none.
 */
const ALIASES = Object.freeze({
  FB_SMOKE_READ_PAGE_ID: SMOKE_ENV.readPageId,
  FB_SMOKE_READ_PAGE_TOKEN: SMOKE_ENV.readPageToken,
  FB_SMOKE_READ_TOKEN: SMOKE_ENV.readPageToken,
  FB_SMOKE_TEST_TOKEN: SMOKE_ENV.testPageToken,
  FB_SMOKE_TEST_PAGE: SMOKE_ENV.testPageId,
  FB_SMOKE_PAGE: SMOKE_ENV.readPageId,
});

/** Profiles the harness injects; an operator-set variable under them is overwritten or mixed in. */
const RESERVED_PROFILE_PREFIXES = Object.freeze([
  'FB_PROFILE_SMOKETEST_',
  'FB_PROFILE_SMOKEREAD_',
]);

/** Server settings `buildChildEnv` forces for the run, whatever the operator set. */
const FORCED_CHILD_VARS = Object.freeze([
  'FB_TRANSPORT',
  'FB_WRITE_MODE',
  'FB_TOOL_PACKAGES',
  'FB_PACKAGES_DENY',
  'FB_PACKAGES_READONLY',
]);

const TOKEN_VARS = Object.freeze([
  'FB_SYSTEM_TOKEN',
  'FB_ACCESS_TOKEN',
  'FB_PAGE_TOKEN',
  SMOKE_ENV.readPageToken,
  SMOKE_ENV.testPageToken,
]);

const ID_VARS = Object.freeze([SMOKE_ENV.readPageId, SMOKE_ENV.testPageId, 'FB_PAGE_ID']);

const REEL_EXTENSIONS = Object.freeze(['.mp4', '.mov']);

function nonEmpty(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Plain Levenshtein distance; the names involved are short. */
export function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

const stem = (name) => name.toUpperCase().replace(/^FB_(SMOKE_)?/, '');

/**
 * The known name `name` most likely meant, or `undefined` when nothing is close.
 * Compared both as written and with the `FB_` / `FB_SMOKE_` prefix stripped, so
 * a misplaced prefix (FB_SMOKE_MEDIA_DIR) costs nothing.
 */
export function closestName(name, candidates) {
  const upper = name.toUpperCase();
  if (Object.hasOwn(ALIASES, upper)) return ALIASES[upper];
  let best;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.min(
      editDistance(upper, candidate),
      editDistance(stem(upper), stem(candidate)),
    );
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const limit = Math.max(2, Math.floor(stem(upper).length / 4));
  return bestDistance <= limit ? best : undefined;
}

/** Every FB_SMOKE* name the harness reads, given the registered smokes. */
export function knownSmokeVars(smokes = []) {
  const names = new Set([
    ...Object.values(SMOKE_ENV),
    ...SMOKE_OPTION_VARS,
    ...REHEARSAL_VARS,
  ]);
  for (const smoke of smokes) {
    for (const name of smoke.requires) {
      if (name.startsWith('FB_SMOKE')) names.add(name);
    }
  }
  return names;
}

/**
 * Problems with the NAMES in the environment: unknown FB_SMOKE* variables
 * (with a suggestion), the rehearsal switches leaking into a live shell, the
 * gate set to something other than "1", and variables the harness reserves.
 * Needs no registry, so `run.mjs --plan` can still report these when loading
 * the smoke modules itself fails (the rehearsal preload throws at import).
 *
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function envNameProblems(env, smokes = []) {
  const problems = [];
  const warnings = [];
  const known = knownSmokeVars(smokes);
  const candidates = [...known, ...SERVER_VARS].filter(
    (name) => !REHEARSAL_VARS.includes(name),
  );

  for (const name of Object.keys(env).sort()) {
    if (!/^FB_SMOKE/i.test(name) || known.has(name)) continue;
    const suggestion = closestName(name, candidates);
    problems.push(
      `${name} is not a variable the smoke harness reads` +
        (suggestion === undefined ? ' — remove it' : ` — did you mean ${suggestion}?`),
    );
  }

  const rehearsal = REHEARSAL_VARS.filter((name) => env[name] !== undefined);
  if (rehearsal.length > 0) {
    problems.push(
      `${rehearsal.join(' and ')} ${rehearsal.length === 1 ? 'is' : 'are'} set — these belong ` +
        'to the offline rehearsal only (rehearse.mjs sets them for its own child). In a live ' +
        'run they collapse every eventual-consistency wait to zero or redirect Graph traffic; ' +
        'unset them',
    );
  }

  const gate = env[SMOKE_ENV.gate];
  if (gate !== undefined && gate !== '1') {
    problems.push(
      `${SMOKE_ENV.gate} is set to ${JSON.stringify(clip(gate, 20))}, not "1" — the live run ` +
        'only opens for exactly "1" and would refuse',
    );
  }

  for (const name of Object.keys(env).sort()) {
    if (RESERVED_PROFILE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      problems.push(
        `${name} is set, but the harness owns the ${name.split('_')[2].toLowerCase()} profile ` +
          `and derives it from ${SMOKE_ENV.testPageId} / ${SMOKE_ENV.readPageId} — unset it`,
      );
    }
  }
  const forced = FORCED_CHILD_VARS.filter((name) => env[name] !== undefined);
  if (forced.length > 0) {
    warnings.push(
      `${forced.join(', ')} ${forced.length === 1 ? 'is' : 'are'} overridden for the smoke ` +
        'run (stdio transport, plan write mode, and only the packages the selected smokes declare)',
    );
  }
  return { problems, warnings };
}

/** Why a token value cannot be what the variable expects, or undefined. Never echoes it. */
function tokenShapeProblem(raw) {
  const value = raw.trim();
  if (/^bearer\s/i.test(value)) return 'starts with "Bearer " — paste the token alone';
  if (/^(['"]).*\1$/.test(value))
    return 'is wrapped in quotes — the quotes become part of it';
  if (/[<>]/.test(value)) return 'still contains a <placeholder>';
  if (/\s/.test(value)) return 'contains whitespace — a token is one unbroken string';
  return undefined;
}

/**
 * Shape checks on the values. `relevant(name)` decides whether a malformed value
 * blocks THIS selection (a problem) or only a smoke that is not selected (a
 * warning) — a broken FB_SMOKE_REEL_PATH should not refuse a read-only run.
 */
function valueProblems(env, { relevant, sweepEnabled }) {
  const problems = [];
  const warnings = [];
  const report = (name, message) => (relevant(name) ? problems : warnings).push(message);

  for (const name of ID_VARS) {
    const value = nonEmpty(env, name);
    if (value !== undefined && !/^\d+$/.test(value)) {
      problems.push(
        `${name} must be a numeric Page id (got ${JSON.stringify(clip(value, 40))}) — not a ` +
          'username, a URL or a profile key',
      );
    }
  }

  for (const name of TOKEN_VARS) {
    const value = nonEmpty(env, name);
    if (value === undefined) continue;
    const problem = tokenShapeProblem(value);
    if (problem !== undefined) problems.push(`${name} ${problem}`);
  }

  const testToken = nonEmpty(env, SMOKE_ENV.testPageToken);
  const testPageId = nonEmpty(env, SMOKE_ENV.testPageId);
  if (testToken !== undefined && testPageId === undefined) {
    problems.push(
      `${SMOKE_ENV.testPageToken} is set but ${SMOKE_ENV.testPageId} is not — the token is ` +
        'ignored without the Page it belongs to',
    );
  }
  if (testToken !== undefined) {
    for (const other of [SMOKE_ENV.readPageToken, 'FB_PAGE_TOKEN']) {
      if (nonEmpty(env, other) === testToken) {
        problems.push(
          `${SMOKE_ENV.testPageToken} and ${other} hold the same token — a Page token belongs ` +
            'to one Page, and the test Page must not be a Page you care about',
        );
      }
    }
  }

  const confirm = env[CONFIRM_TOKEN_VAR];
  if (typeof confirm === 'string' && confirm.length < MIN_CONFIRM_TOKEN_CHARS) {
    const message =
      `${CONFIRM_TOKEN_VAR} is ${confirm.length} characters; the server ignores one shorter ` +
      `than ${MIN_CONFIRM_TOKEN_CHARS}, so every delete — each smoke's cleanup and the sweep — ` +
      'would be denied';
    (relevant(CONFIRM_TOKEN_VAR) || sweepEnabled ? problems : warnings).push(message);
  }

  const photo = nonEmpty(env, 'FB_SMOKE_PHOTO_URL');
  if (photo !== undefined) {
    let ok;
    try {
      ok = new URL(photo).protocol === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) {
      report(
        'FB_SMOKE_PHOTO_URL',
        'FB_SMOKE_PHOTO_URL must be an https:// URL Meta can fetch (a local path does not work)',
      );
    }
  }

  const adAccount = nonEmpty(env, 'FB_AD_ACCOUNT_ID');
  if (adAccount !== undefined && !/^(act_)?\d+$/.test(adAccount)) {
    const hint = /^act[-_ ]?\d+$/i.test(adAccount)
      ? ` — write it as act_${adAccount.replace(/^act[-_ ]?/i, '')}`
      : '';
    report(
      'FB_AD_ACCOUNT_ID',
      `FB_AD_ACCOUNT_ID must be act_<digits> or the bare digits (got ` +
        `${JSON.stringify(clip(adAccount, 40))})${hint}`,
    );
  }

  const mediaDir = nonEmpty(env, 'FB_MEDIA_DIR');
  let mediaReal;
  if (mediaDir !== undefined) {
    try {
      if (!statSync(mediaDir).isDirectory()) {
        report('FB_MEDIA_DIR', `FB_MEDIA_DIR is not a directory: ${mediaDir}`);
      } else {
        mediaReal = realpathSync(mediaDir);
      }
    } catch {
      report('FB_MEDIA_DIR', `FB_MEDIA_DIR does not exist: ${mediaDir}`);
    }
  }

  const reel = nonEmpty(env, 'FB_SMOKE_REEL_PATH');
  if (reel !== undefined) {
    let reelReal;
    try {
      const stats = statSync(reel);
      if (!stats.isFile()) {
        report('FB_SMOKE_REEL_PATH', `FB_SMOKE_REEL_PATH is not a file: ${reel}`);
      } else if (stats.size === 0) {
        report('FB_SMOKE_REEL_PATH', `FB_SMOKE_REEL_PATH is an empty file: ${reel}`);
      } else {
        reelReal = realpathSync(reel);
      }
    } catch {
      report('FB_SMOKE_REEL_PATH', `FB_SMOKE_REEL_PATH does not exist: ${reel}`);
    }
    if (!REEL_EXTENSIONS.includes(extname(reel).toLowerCase())) {
      report(
        'FB_SMOKE_REEL_PATH',
        `FB_SMOKE_REEL_PATH must be an ${REEL_EXTENSIONS.join(' or ')} video: ${reel}`,
      );
    }
    if (reelReal !== undefined && mediaReal !== undefined) {
      const rel = relative(mediaReal, reelReal);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        report(
          'FB_SMOKE_REEL_PATH',
          `FB_SMOKE_REEL_PATH resolves outside FB_MEDIA_DIR — the server confines local media ` +
            `to that directory by realpath and would refuse the upload (${reel})`,
        );
      }
    }
  }

  return { problems, warnings };
}

/** Why a smoke the selection did not pick is not running. */
function skipReason(smoke, { only, phases, sweepOnly, budgetSkips }) {
  if (sweepOnly) return '--sweep-only runs no smokes';
  if (only.length > 0) return 'not named by --only';
  if (phases.length > 0 && !phases.includes(smoke.phase)) {
    return `phase ${smoke.phase} not selected (--phase ${phases.join(',')})`;
  }
  return budgetSkips.get(smoke.id) ?? 'not selected';
}

/**
 * Build the plan. Pure over its inputs apart from the local `fs` checks.
 *
 * @param {{
 *   env: Record<string, string|undefined>,
 *   args: { only: string[], phases: number[], includeBudget: boolean,
 *           sweepOnly: boolean, keep: boolean, serverPath: string },
 *   smokes: object[],
 *   sweepers: object[],
 * }} input
 */
export function buildPlan({ env, args, smokes, sweepers }) {
  const problems = [];
  const warnings = [];
  const notes = [];

  const names = envNameProblems(env, smokes);
  problems.push(...names.problems);
  warnings.push(...names.warnings);

  let selection = { selected: [], skipped: [] };
  let selectionRefused = false;
  try {
    selection = selectFrom(smokes, {
      only: args.only,
      phases: args.phases,
      includeBudget: args.includeBudget,
    });
  } catch (err) {
    selectionRefused = true;
    problems.push(err instanceof Error ? err.message : String(err));
  }
  const selected = args.sweepOnly ? [] : selection.selected;
  const budgetSkips = new Map(
    selection.skipped.map(({ smoke, reason }) => [smoke.id, reason]),
  );
  const selectedIds = new Set(selected.map((smoke) => smoke.id));

  const rows = smokes.map((smoke) => {
    if (!selectedIds.has(smoke.id)) {
      return {
        smoke,
        status: 'skip',
        reason: skipReason(smoke, { ...args, budgetSkips }),
      };
    }
    const missing = smoke.requires.filter((name) => nonEmpty(env, name) === undefined);
    return missing.length > 0
      ? { smoke, status: 'blocked', reason: `missing ${missing.join(', ')}` }
      : { smoke, status: 'run', reason: '' };
  });

  if (selected.length === 0 && !args.sweepOnly && !selectionRefused) {
    problems.push('no smokes selected — run with --list to see what exists');
  }

  let cfg;
  try {
    cfg = resolveSmokeEnv({
      env,
      smokes: selected,
      requireTestPage: args.sweepOnly,
      sweepPackages: sweepers.flatMap((sweeper) => sweeper.packages),
    });
    warnings.push(...cfg.warnings);
  } catch (err) {
    if (!(err instanceof SmokeConfigError)) throw err;
    problems.push(...err.problems);
  }
  const sweepEnabled =
    cfg?.sweepEnabled ?? nonEmpty(env, SMOKE_ENV.testPageId) !== undefined;

  const wanted = new Set(selected.flatMap((smoke) => smoke.requires));
  const values = valueProblems(env, {
    relevant: (name) => wanted.has(name),
    sweepEnabled,
  });
  problems.push(...values.problems);
  warnings.push(...values.warnings);

  if (!existsSync(args.serverPath)) {
    problems.push(
      `the server is not built: ${args.serverPath} does not exist — run npm run build`,
    );
  }
  if (env[SMOKE_ENV.gate] === undefined) {
    notes.push(
      `${SMOKE_ENV.gate} is not set — the plan does not need it; the live run does`,
    );
  }

  const running = rows.filter((row) => row.status === 'run');
  const leftBehind = [];
  for (const row of running) {
    if (!row.smoke.writes) continue;
    for (const item of row.smoke.effects.leaves) {
      leftBehind.push({ id: row.smoke.id, item });
    }
    if (args.keep) {
      for (const item of row.smoke.effects.creates) {
        leftBehind.push({
          id: row.smoke.id,
          item: `${item} (--keep skips the end sweep)`,
        });
      }
    }
  }

  return {
    runnable: problems.length === 0,
    problems,
    warnings,
    notes,
    rows,
    sweep: {
      enabled: sweepEnabled,
      sweepOnly: args.sweepOnly,
      keep: args.keep,
      sweepers,
    },
    leftBehind,
    readPageId:
      cfg?.readPageId ??
      nonEmpty(env, SMOKE_ENV.readPageId) ??
      nonEmpty(env, 'FB_PAGE_ID'),
    testPageId: cfg?.testPageId ?? nonEmpty(env, SMOKE_ENV.testPageId),
    command: liveCommand(args),
  };
}

/** The live command that runs what this plan describes. */
function liveCommand(args) {
  const flags = [];
  if (args.only.length > 0) flags.push(`--only ${args.only.join(',')}`);
  else if (args.phases.length > 0) flags.push(`--phase ${args.phases.join(',')}`);
  if (args.includeBudget && args.only.length === 0) flags.push('--include-budget');
  if (args.sweepOnly) flags.push('--sweep-only');
  if (args.keep) flags.push('--keep');
  return `${SMOKE_ENV.gate}=1 npm run smoke${flags.length > 0 ? ` -- ${flags.join(' ')}` : ''}`;
}

const STATUS_LABEL = Object.freeze({ run: 'RUN', skip: 'SKIP', blocked: 'BLOCKED' });

function describeCredential(env) {
  const set = ['FB_SYSTEM_TOKEN', 'FB_ACCESS_TOKEN', 'FB_PAGE_TOKEN'].filter(
    (name) => nonEmpty(env, name) !== undefined,
  );
  return set.length === 0 ? 'none set' : `${set.join(', ')} set (hidden)`;
}

function describeSet(env, name) {
  return nonEmpty(env, name) === undefined ? 'not set' : 'set (hidden)';
}

function describeValue(env, name) {
  const value = nonEmpty(env, name);
  return value === undefined ? 'not set' : clip(value, 120);
}

/**
 * Render a plan for the terminal. The whole text goes through `scrub()` as a
 * second line of defence; the first is that no token value is formatted at all.
 */
export function formatPlan(plan, env = process.env) {
  const lines = [];
  const counts = { run: 0, skip: 0, blocked: 0 };
  for (const row of plan.rows) counts[row.status] += 1;

  lines.push(
    'facebook-mcp live smoke plan — offline: no network call, no server spawned',
  );
  lines.push('');
  lines.push('Configuration');
  const config = [
    ['credential', describeCredential(env)],
    ['read Page', plan.readPageId ?? 'not set'],
    [
      'test Page (writes)',
      plan.testPageId ?? 'not set — write smokes and the sweep refuse',
    ],
    [SMOKE_ENV.readPageToken, describeSet(env, SMOKE_ENV.readPageToken)],
    [SMOKE_ENV.testPageToken, describeSet(env, SMOKE_ENV.testPageToken)],
    [CONFIRM_TOKEN_VAR, describeSet(env, CONFIRM_TOKEN_VAR)],
    ['FB_SMOKE_PHOTO_URL', describeValue(env, 'FB_SMOKE_PHOTO_URL')],
    ['FB_MEDIA_DIR', describeValue(env, 'FB_MEDIA_DIR')],
    ['FB_SMOKE_REEL_PATH', describeValue(env, 'FB_SMOKE_REEL_PATH')],
    ['FB_AD_ACCOUNT_ID', describeValue(env, 'FB_AD_ACCOUNT_ID')],
  ];
  for (const [label, value] of config) {
    lines.push(`  ${label.padEnd(26)} ${value}`);
  }

  lines.push('');
  lines.push(
    `Smokes — ${counts.run} run, ${counts.skip} skipped, ${counts.blocked} blocked`,
  );
  for (const { smoke, status, reason } of plan.rows) {
    const flags = [
      `phase ${smoke.phase}`,
      smoke.writes ? 'WRITES' : 'read-only',
      `page:${smoke.page}`,
      ...(smoke.budget === null ? [] : [`BUDGET:${smoke.budget}`]),
    ];
    lines.push(
      `  ${STATUS_LABEL[status].padEnd(8)} ${smoke.id.padEnd(34)} ${flags.join(' · ')}`,
    );
    const detail = (label, text) =>
      lines.push(`${' '.repeat(11)}${`${label}:`.padEnd(19)} ${text}`);
    if (reason !== '') detail('why', reason);
    if (!smoke.writes) continue;
    const verb = status === 'run' ? '' : 'would ';
    for (const item of smoke.effects.creates) detail(`${verb}create`, item);
    for (const item of smoke.effects.cleansUp) detail(`${verb}clean up`, item);
    for (const item of smoke.effects.leaves) detail(`${verb}LEAVE`, item);
  }

  lines.push('');
  lines.push('Sweep (test Page only; deletes marked artifacts from ANY run)');
  if (!plan.sweep.enabled) {
    lines.push(`  none — ${SMOKE_ENV.testPageId} is not set`);
  } else {
    lines.push('  start sweep: before the smokes, clears leftovers from earlier runs');
    if (plan.sweep.sweepOnly) {
      lines.push('  --sweep-only: no smokes, no end sweep');
    } else if (plan.sweep.keep) {
      lines.push(
        "  end sweep:   SKIPPED (--keep) — this run's artifacts stay until the next start sweep",
      );
    } else {
      lines.push('  end sweep:   after the smokes, even on failure or Ctrl-C');
    }
    for (const sweeper of plan.sweep.sweepers) {
      lines.push(`    ${sweeper.id.padEnd(10)} ${sweeper.title}`);
    }
    lines.push('  Reels are never swept: a Reel left behind is deleted by hand.');
  }

  lines.push('');
  lines.push('Left on the real Page after this run');
  if (plan.leftBehind.length === 0) {
    lines.push('  nothing — every artifact this run creates is cleaned up');
  } else {
    for (const { id, item } of plan.leftBehind) lines.push(`  - ${id}: ${item}`);
  }

  for (const [title, items] of [
    ['Notes', plan.notes],
    ['Warnings', plan.warnings],
  ]) {
    if (items.length === 0) continue;
    lines.push('');
    lines.push(title);
    for (const item of items) lines.push(`  - ${item}`);
  }

  lines.push('');
  if (plan.runnable) {
    lines.push(`Result: runnable. Next: npm run smoke:rehearse, then ${plan.command}`);
  } else {
    lines.push(`Problems (${plan.problems.length}) — the live run would refuse:`);
    for (const problem of plan.problems) lines.push(`  - ${problem}`);
    lines.push('');
    lines.push(
      `Result: NOT runnable — fix the ${plan.problems.length} problem(s) above.`,
    );
  }
  return scrub(`${lines.join('\n')}\n`, env);
}
