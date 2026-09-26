#!/usr/bin/env node
// Live smoke runner — the harness that proves the SHIPPED server works against
// the real Graph API (doc 08, "Smoke Safety Protocol"; task S01).
//
// These are not tests. `npm test` runs hermetic unit tests over `build/**/*.test.js`
// with no network and no credentials; this harness deliberately sits OUTSIDE
// that glob and outside `tsconfig`'s `rootDir`, is written in plain `.mjs` so it
// is never compiled into the published build, and runs only when a human asks
// for it. CI never runs it and never holds a token (C13).
//
// What it does, in order:
//
//   1. refuses unless `FB_SMOKE=1` (exit 2, nothing executed, no network call);
//   2. refuses unless the environment is complete AND safe for the selected
//      smokes — reporting every problem at once (exit 2, still no network call);
//   3. spawns `build/index.js` over stdio and connects an MCP SDK client;
//   4. sweeps the test Page for leftovers from earlier runs (CC-LIFE-3);
//   5. runs the selected smokes, each with a wall-clock timeout;
//   6. sweeps AGAIN in a `finally` — after success, after a thrown smoke, after
//      a timeout, after Ctrl-C — and reports anything it could not delete;
//   7. prints a summary and exits 0 / 1 / 2.
//
// Exit status (deliberate, documented, and depended upon by CI-adjacent scripts):
//
//   0  every selected smoke passed and the test Page was left clean.
//      Two things can be true at exit 0, and BOTH are always named on the
//      `result` line rather than buried (see `printSummary`):
//        * a smoke that ran clean but could not exercise its contract, because
//          the live Page held no data of the shape it needs (`ctx.notExercised`);
//        * `--keep`, which suppresses the end sweep by explicit request, so this
//          run's artifacts are still on the test Page.
//   1  a smoke failed, or the sweep could not delete a marked artifact
//   2  refused to run — the gate is off, the environment is incomplete or
//      unsafe, an unknown smoke id was selected, or the server is not built.
//      A non-zero status is deliberate: a misconfigured job must never report a
//      green run for a gate that never opened.
//
// Usage: see `--help`, and `scripts/smoke/README.md`.

import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  startSmokeClient,
  unwrapTainted,
  SmokeSetupError,
  SmokeTransportError,
} from './client.mjs';
import {
  READ_PROFILE,
  SMOKE_ENV,
  SmokeConfigError,
  TEST_PROFILE,
  gateEnabled,
  gateRefusalMessage,
  resolveSmokeEnv,
} from './env.mjs';
import { clip, createLogger, runBanner, scrub } from './log.mjs';
import { formatCoverageLine, toolCoverage } from './coverage.mjs';
import { createNonce, mark, markerFor } from './nonce.mjs';
import {
  SmokeRegistrationError,
  listSmokes,
  listSweepers,
  loadModules,
  selectSmokes,
} from './registry.mjs';
import { runEndSweep, runSweep, sweepUnavailable } from './sweeper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const DEFAULT_SERVER = resolve(REPO_ROOT, 'build', 'index.js');
const DEFAULT_TIMEOUT_MS = 180_000;

/** Documented exit statuses (see the header). */
export const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });

/** A smoke's own expectation was not met. */
class SmokeAssertionError extends Error {
  name = 'SmokeAssertionError';
}

const USAGE = `facebook-mcp live smoke harness

  FB_SMOKE=1 npm run smoke [-- <options>]

Options
  --list                 Show every registered smoke and exit (no gate, no network).
  --only <id[,id...]>    Run exactly these smoke ids. Repeatable. Naming a
                         budget-consuming smoke here is itself the opt-in.
  --phase <n>            Run only smokes of this roadmap phase. Repeatable.
                         Ignored when --only is given: an explicit id is exact.
  --include-budget       Also run smokes that consume a finite live quota
                         (Reels 30/24h, ad spend). Off by default, on purpose.
  --sweep-only           Skip the smokes; just sweep the test Page for
                         leftovers. This is the "clean up after a crash" mode.
  --keep                 Skip the END sweep and leave this run's artifacts on
                         the test Page for inspection. The NEXT run's start
                         sweep will delete them.
  --server <path>        Server entry point (default: build/index.js).
  --timeout <ms>         Per-smoke wall clock and per-request timeout
                         (default: ${DEFAULT_TIMEOUT_MS}).
  --verbose              Stream the server's stderr log lines (scrubbed).
  --help                 Show this text.

Environment
  ${SMOKE_ENV.gate}=1                 required — the harness refuses without it
  FB_SYSTEM_TOKEN            preferred credential (or FB_ACCESS_TOKEN)
  ${SMOKE_ENV.readPageId}         Page the read-only smokes read (default: FB_PAGE_ID)
  ${SMOKE_ENV.testPageId}    Page every write smoke and the sweeper target.
                             No fallback: unset ⇒ write smokes refuse to run.
  ${SMOKE_ENV.readPageToken}      optional explicit Page token for the read Page
  ${SMOKE_ENV.testPageToken} optional explicit Page token for the test Page
`;

/** Parse `process.argv.slice(2)`. Exported so it can be exercised in isolation. */
export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      list: { type: 'boolean', default: false },
      only: { type: 'string', multiple: true, default: [] },
      phase: { type: 'string', multiple: true, default: [] },
      'include-budget': { type: 'boolean', default: false },
      'sweep-only': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      server: { type: 'string' },
      timeout: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  // `Number('')` is 0, so an empty value would quietly resolve to phase 0 — the
  // core skeleton — instead of being refused. That is exactly what `--phase
  // "$PHASE"` does when the variable is unset, and a run that silently narrows
  // to a phase nobody asked for is worse than one that stops.
  const phases = values.phase
    .flatMap((raw) => raw.split(','))
    .map((raw) => raw.trim())
    .map((raw) => (raw === '' ? Number.NaN : Number(raw)));
  if (phases.some((phase) => !Number.isInteger(phase))) {
    throw new SmokeRegistrationError('--phase takes integers, e.g. --phase 1');
  }
  const timeoutMs =
    values.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(values.timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new SmokeRegistrationError('--timeout takes a positive number of milliseconds');
  }

  // Same trap in the opposite direction: `--only "$IDS"` with an unset variable
  // filters down to nothing, and an empty `only` means "no narrowing" — so the
  // request to run ONE smoke would run the whole default set against a live
  // Page. An empty selector is a mistake, never a wildcard.
  const only = values.only
    .flatMap((raw) => raw.split(','))
    .map((raw) => raw.trim())
    .filter(Boolean);
  if (values.only.length > 0 && only.length === 0) {
    throw new SmokeRegistrationError(
      '--only takes at least one smoke id, e.g. --only reader/timeline',
    );
  }

  return {
    list: values.list,
    only,
    phases,
    includeBudget: values['include-budget'],
    sweepOnly: values['sweep-only'],
    keep: values.keep,
    serverPath: values.server === undefined ? DEFAULT_SERVER : resolve(values.server),
    timeoutMs,
    verbose: values.verbose,
    help: values.help,
  };
}

/** Import every smoke and sweeper file. Registration happens at module scope. */
async function loadRegistrations() {
  await loadModules(resolve(HERE, 'smokes'), '.smoke.mjs');
  await loadModules(resolve(HERE, 'sweepers'), '.sweep.mjs');
}

function formatSmokeRow(smoke) {
  const flags = [
    `phase ${smoke.phase}`,
    smoke.writes ? 'WRITES' : 'read-only',
    `page:${smoke.page}`,
    ...(smoke.budget === null ? [] : [`BUDGET:${smoke.budget}`]),
    // Printed because the refusal for a missing one points here: a run that is
    // blocked on FB_CONFIRM_TOKEN needs a way to see which smokes to drop.
    ...(smoke.requires.length === 0 ? [] : [`requires:${smoke.requires.join('+')}`]),
  ];
  return `  ${smoke.id.padEnd(34)} ${smoke.title}\n${' '.repeat(36)} ${flags.join(' · ')}`;
}

/**
 * Run one smoke with a wall clock. Never throws; returns a result record whose
 * `status` is one of:
 *
 *   'passed'         the smoke ran and exercised what it claims to cover;
 *   'not-exercised'  the smoke ran clean but reported, via `ctx.notExercised`,
 *                    that some part of its contract never got executed because
 *                    the live Page holds no data of the required shape;
 *   'failed'         an assertion, a tool error, a safety refusal, or a timeout.
 *
 * The middle one exists because this harness's entire purpose is to produce
 * evidence that the shipped server works against the real Graph API — and a
 * smoke that early-returns on "the Page has no published posts" produces no
 * such evidence while still colouring the run green. Seven scenarios do exactly
 * that, one of them the only check that a stranger's text arrives taint-wrapped.
 * Folding them into `passed` would make the gate's headline number a lie.
 */
async function runOneSmoke(smoke, { session, cfg, nonce, log, timeoutMs, controllers }) {
  const controller = new AbortController();
  controllers.add(controller);
  const started = Date.now();

  /** Reasons collected by `ctx.notExercised`, in call order. */
  const unexercised = [];

  const profile =
    smoke.page === 'test'
      ? TEST_PROFILE
      : smoke.page === 'read'
        ? READ_PROFILE
        : undefined;

  const ctx = {
    nonce,
    marker: markerFor(nonce),
    mark: (text) => mark(text, nonce),
    profile,
    pages: {
      testProfile: TEST_PROFILE,
      testPageId: cfg.testPageId,
      readProfile: READ_PROFILE,
      readPageId: cfg.readPageId,
    },
    callTool: session.callTool,
    callToolRaw: session.callToolRaw,
    applyWrite: session.applyWrite,
    listTools: session.listTools,
    unwrap: unwrapTainted,
    signal: controller.signal,
    log,
    assert: (condition, message) => {
      if (!condition) {
        throw new SmokeAssertionError(message);
      }
    },
    // Record that a part of this smoke's contract could not be executed against
    // the live Page. Deliberately does NOT throw: a smoke may verify five of its
    // six behaviours and legitimately have to skip the sixth, and forcing an
    // early exit would throw away the five it did verify. Call it and then
    // `return` if the whole scenario is unreachable, or call it and carry on if
    // only one branch is. Every reason is echoed here as it happens and listed
    // again in the summary, so it is visible both live and after the fact.
    notExercised: (reason) => {
      const text =
        typeof reason === 'string' && reason.trim() !== ''
          ? reason.trim()
          : 'no reason given';
      unexercised.push(text);
      log.step(`NOT EXERCISED: ${text}`);
    },
  };

  let timer;
  try {
    const budget = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([smoke.run(ctx), budget]);
    const ms = Date.now() - started;
    if (unexercised.length > 0) {
      log.skip(
        `${smoke.id} — NOT EXERCISED (${ms} ms): ${unexercised.length} part(s) of the contract could not run`,
      );
      return { smoke, status: 'not-exercised', ms, unexercised };
    }
    log.ok(`${smoke.id} (${ms} ms)`);
    return { smoke, status: 'passed', ms, unexercised };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.fail(`${smoke.id}: ${clip(message, 800)}`);
    return {
      smoke,
      status: 'failed',
      ms: Date.now() - started,
      error: message,
      unexercised,
    };
  } finally {
    clearTimeout(timer);
    controllers.delete(controller);
  }
}

function printSummary({
  log,
  results,
  skipped,
  startSweep,
  endSweep,
  sweepEnabled,
  nonce,
  keep,
  coverage,
  coverageIsFullSurface,
}) {
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed');
  const notExercised = results.filter((r) => r.status === 'not-exercised');
  const leaked = [...(startSweep?.leaked ?? []), ...(endSweep?.leaked ?? [])];
  const swept = (startSweep?.deleted.length ?? 0) + (endSweep?.deleted.length ?? 0);

  // A sweep that did not happen is not a clean Page, and the counts above
  // cannot express the difference — 0 leaked reads identically either way.
  const sweepNotes = [];
  if (!sweepEnabled) {
    sweepNotes.push('no test Page configured, so no sweep ran');
  } else {
    if (startSweep === undefined || startSweep.skipped === true) {
      sweepNotes.push('the start sweep did not run');
    }
    if (endSweep === undefined && keep) {
      sweepNotes.push('the end sweep was suppressed by --keep');
    } else if (endSweep === undefined || endSweep.skipped === true) {
      sweepNotes.push('the end sweep did not run');
    }
  }

  log.line('');
  log.line('Summary');
  log.info(
    `smokes   ${passed} passed, ${failed.length} failed, ${notExercised.length} not exercised, ` +
      `${skipped.length} skipped (budget/selection)`,
  );
  log.info(
    `sweep    ${swept} artifact(s) deleted, ${leaked.length} left behind` +
      `${sweepNotes.length === 0 ? '' : ` — ${sweepNotes.join('; ')}`}`,
  );
  // WHICH tools this run is evidence for. The smoke count above cannot answer
  // that — a scenario is not a tool — and the difference is the whole value of
  // the line an operator quotes when they open a release gate.
  if (coverage !== undefined) {
    const line = `tools    ${formatCoverageLine(coverage)}`;
    if (coverage.uncovered.length > 0) log.warn(line);
    else log.info(line);
    // A name the run called that the server never listed comes back as "unknown
    // tool", which reads like an ordinary tool error inside a smoke. It is not:
    // it means this selection does not load the package the smoke assumes.
    if (coverage.unadvertised.length > 0) {
      log.fail(
        `tools    called but never advertised: ${coverage.unadvertised.join(', ')} — ` +
          'the smoke is calling a tool this package selection does not load',
      );
    }
  }
  log.info(`marker   ${markerFor(nonce)}`);
  for (const result of failed) {
    log.fail(`${result.smoke.id}: ${clip(result.error ?? 'failed', 300)}`);
  }
  // WHAT went unverified, not just how much of it. An operator reading this is
  // deciding whether the test Page needs seeding (a post, a conversation, a
  // Reel, a comment from a second account) before the gate means anything.
  for (const result of notExercised) {
    for (const reason of result.unexercised) {
      log.skip(`not exercised — ${result.smoke.id}: ${clip(reason, 300)}`);
    }
  }
  for (const item of leaked) {
    log.fail(`leftover ${item.kind} ${item.id}: ${item.reason ?? 'unknown reason'}`);
  }
  if (keep) {
    log.warn(
      `--keep: this run's artifacts were left on the test Page. The next run's start sweep ` +
        'will delete them (or run with --sweep-only now).',
    );
  }

  // The exit code, and why each of the three inputs maps the way it does.
  //
  // failed smoke / leaked artifact → 1. Both are defects: the server misbehaved,
  //   or the harness dirtied a Page it promised to clean.
  //
  // not exercised → 0, but never a bare "PASS". A smoke that could not exercise
  //   its contract is a statement about the test PAGE, not about the server: an
  //   idle Page has no published post, no conversation, no Reel, no metric with
  //   a full window. Failing the run for that would make the gate red on a
  //   property no code change can fix, and a gate that goes red for reasons
  //   outside the code is a gate people learn to ignore — which would cost more
  //   safety than it buys. So the status stays 0 and the honesty is carried by
  //   the report instead: every reason is listed above, the count sits next to
  //   `passed`, and the `result` line refuses to say a plain "PASS" while any
  //   part of the contract went unverified.
  //
  // --keep → 0, same reasoning applied to the sweep. The exit-0 clause "the test
  //   Page was left clean" is waived here by explicit operator instruction; a
  //   flag that always returned 1 would be useless in the one workflow it exists
  //   for (leave the artifacts, go look at them). The result line names it.
  const ok = failed.length === 0 && leaked.length === 0;
  const caveats = [];
  if (notExercised.length > 0) {
    caveats.push(
      `${notExercised.length} smoke(s) NOT EXERCISED (this run is not evidence for what they cover)`,
    );
  }
  if (keep) {
    caveats.push("this run's artifacts were KEPT on the test Page (--keep)");
  }
  // Only for the unfiltered run. `--only` and `--phase` narrow the SELECTION,
  // and the package set is derived from it, so a targeted run legitimately
  // leaves most of its own advertised surface untouched — shouting about that
  // every time is how a caveat stops being read. The full run is the one whose
  // headline gets quoted as "the server works", and there the gap is the point.
  if (
    coverageIsFullSurface === true &&
    coverage !== undefined &&
    coverage.uncovered.length > 0
  ) {
    caveats.push(
      `${coverage.uncovered.length} advertised tool(s) were NEVER CALLED (this run is not evidence for them)`,
    );
  }
  log.info(
    `result   ${ok ? 'PASS' : 'FAIL'}${caveats.length === 0 ? '' : ` — ${caveats.join('; ')}`}`,
  );
  return ok ? EXIT.ok : EXIT.failed;
}

async function main() {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    // Scrubbed like every other output path: `parseArgs` echoes the offending
    // argument back, and an operator who mistyped a flag next to a pasted token
    // would otherwise have it printed verbatim.
    process.stderr.write(scrub(`${err instanceof Error ? err.message : String(err)}\n`));
    return EXIT.refused;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }

  const log = createLogger({ verbose: args.verbose });

  await loadRegistrations();

  if (args.list) {
    const smokes = listSmokes();
    process.stdout.write(
      smokes.length === 0
        ? 'No smokes registered yet — add one under scripts/smoke/smokes/.\n'
        : `Registered smokes (${smokes.length}):\n${smokes.map(formatSmokeRow).join('\n')}\n`,
    );
    const sweepers = listSweepers();
    process.stdout.write(
      `\nRegistered sweepers (${sweepers.length}):\n${sweepers
        .map((s) => `  ${s.id.padEnd(34)} ${s.title}`)
        .join('\n')}\n`,
    );
    return EXIT.ok;
  }

  // ---- gate: nothing below this line may run without an explicit opt-in ----
  if (!gateEnabled()) {
    log.error(gateRefusalMessage());
    return EXIT.refused;
  }

  let selection;
  try {
    selection = selectSmokes({
      only: args.only,
      phases: args.phases,
      includeBudget: args.includeBudget,
    });
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return EXIT.refused;
  }

  const selected = args.sweepOnly ? [] : selection.selected;
  const skipped = args.sweepOnly ? [] : selection.skipped;

  let cfg;
  try {
    cfg = resolveSmokeEnv({
      smokes: selected,
      requireTestPage: args.sweepOnly,
      sweepPackages: listSweepers().flatMap((sweeper) => sweeper.packages),
    });
  } catch (err) {
    if (err instanceof SmokeConfigError) {
      log.error(err.message);
      return EXIT.refused;
    }
    throw err;
  }

  if (selected.length === 0 && !args.sweepOnly) {
    log.error('no smokes selected — run with --list to see what exists');
    return EXIT.refused;
  }

  const nonce = createNonce();
  log.line(runBanner(nonce, selected));
  log.line('');
  for (const warning of cfg.warnings) {
    log.warn(warning);
  }
  for (const entry of skipped) {
    log.skip(`${entry.smoke.id} — ${entry.reason}`);
  }
  if (!cfg.sweepEnabled) {
    log.warn(
      `${SMOKE_ENV.testPageId} is not set, so no sweep will run. Only read-only smokes can be selected.`,
    );
  }

  let session;
  try {
    session = await startSmokeClient({
      serverPath: args.serverPath,
      env: cfg.childEnv,
      cwd: REPO_ROOT,
      timeoutMs: args.timeoutMs,
      nonce,
      writeTarget: { profile: TEST_PROFILE, pageId: cfg.testPageId },
      log,
    });
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    // The child was spawned but never spoke MCP. Its own stderr is normally the
    // only explanation (a missing credential, a crash on boot), and there is no
    // session left to ask for it later, so it travels on the error itself.
    if (err instanceof SmokeTransportError && err.stderrTail !== '') {
      log.line('');
      log.line('Server stderr (tail, scrubbed):');
      log.line(clip(err.stderrTail, 4000));
    }
    // The start sweep never happened, and it is the ONLY thing that removes
    // artifacts left by an earlier run that crashed. Exiting quietly here would
    // let leftovers accumulate on the test Page across every failed startup.
    if (cfg.sweepEnabled) {
      sweepUnavailable({
        phase: 'start',
        reason: 'the server session never came up',
        consequence: 'anything an earlier run left behind is still on the test Page.',
        log,
      });
    }
    if (err instanceof SmokeSetupError) {
      return EXIT.refused;
    }
    return EXIT.failed;
  }

  const pages = { testProfile: TEST_PROFILE, testPageId: cfg.testPageId };
  const controllers = new Set();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    for (const controller of controllers) {
      controller.abort();
    }
    log.warn('interrupted — finishing the current smoke, then sweeping before exit');
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const results = [];
  let startSweep;
  let endSweep;
  let fatal;
  let coverage;

  try {
    if (cfg.sweepEnabled) {
      startSweep = await runSweep({ phase: 'start', session, pages, nonce, log });
    }
    // Snapshot AFTER the start sweep and read again before the end sweep, so
    // the coverage figure counts what the SMOKES exercised. A sweep calls the
    // delete tools too, and counting those would report the destructive half of
    // the surface as verified by a run that only tidied up after an earlier one.
    const sweptTools = new Set(session.answeredTools());
    for (const smoke of selected) {
      if (interrupted) {
        break;
      }
      log.line(`▶ ${smoke.id} — ${smoke.title}`);
      results.push(
        await runOneSmoke(smoke, {
          session,
          cfg,
          nonce,
          log,
          timeoutMs: args.timeoutMs,
          controllers,
        }),
      );
    }
    // The advertised surface is asked of the live session rather than derived
    // from the selection: the server is the authority on what it loaded, and a
    // mismatch between the two is precisely the drift worth surfacing.
    coverage = toolCoverage({
      advertised: (await session.listTools()).tools.map((tool) => tool.name),
      called: session.answeredTools().filter((name) => !sweptTools.has(name)),
    });
  } catch (err) {
    // A failure OUTSIDE a smoke (transport died, sweep exploded). Recorded, not
    // rethrown: the `finally` below still has to clean the test Page.
    fatal = err instanceof Error ? err.message : String(err);
    log.error(fatal);
  } finally {
    if (cfg.sweepEnabled && !args.keep) {
      endSweep = await runEndSweep({ session, pages, nonce, log });
    }
    await session.close();
  }

  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  const status = printSummary({
    log,
    results,
    skipped,
    startSweep,
    endSweep,
    sweepEnabled: cfg.sweepEnabled,
    nonce,
    keep: args.keep,
    coverage,
    coverageIsFullSurface:
      !args.sweepOnly && args.only.length === 0 && args.phases.length === 0,
  });

  const tail = session.stderrTail();
  if ((status !== EXIT.ok || fatal !== undefined) && tail !== '') {
    log.line('');
    log.line('Server stderr (tail, scrubbed):');
    log.line(clip(tail, 4000));
  }

  if (fatal !== undefined || interrupted) {
    return EXIT.failed;
  }
  return status;
}

// Only run when this file IS the command. `parseCliArgs` is exported so it can
// be exercised in isolation, and without this guard it could not be: importing
// the module started a run — the gate refusal, a spawned server, or a live
// smoke, depending on the importer's environment. `npm run smoke` invokes the
// file by path (`node scripts/smoke/run.mjs`), so comparing argv[1] to this
// module's own path is the whole test.
const isEntryPoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      // A stack trace is the one output nobody composed by hand, so it is also the
      // one most likely to carry a token verbatim — an interpolated URL inside a
      // frame's message, a rejected request echoed by a library. It goes through
      // the same chokepoint as everything else.
      process.stderr.write(
        scrub(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`),
      );
      process.exitCode = EXIT.failed;
    },
  );
}
