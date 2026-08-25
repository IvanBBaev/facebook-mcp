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
//   0  every selected smoke passed and the test Page was left clean
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

import { startSmokeClient, unwrapTainted, SmokeSetupError } from './client.mjs';
import {
  READ_PROFILE,
  SMOKE_ENV,
  SmokeConfigError,
  TEST_PROFILE,
  gateEnabled,
  gateRefusalMessage,
  resolveSmokeEnv,
} from './env.mjs';
import { clip, createLogger, runBanner } from './log.mjs';
import { createNonce, mark, markerFor } from './nonce.mjs';
import {
  SmokeRegistrationError,
  listSmokes,
  listSweepers,
  loadModules,
  selectSmokes,
} from './registry.mjs';
import { runEndSweep, runSweep } from './sweeper.mjs';

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

  const phases = values.phase
    .flatMap((raw) => raw.split(','))
    .map((raw) => Number(raw.trim()));
  if (phases.some((phase) => !Number.isInteger(phase))) {
    throw new SmokeRegistrationError('--phase takes integers, e.g. --phase 1');
  }
  const timeoutMs =
    values.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(values.timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new SmokeRegistrationError('--timeout takes a positive number of milliseconds');
  }

  return {
    list: values.list,
    only: values.only
      .flatMap((raw) => raw.split(','))
      .map((raw) => raw.trim())
      .filter(Boolean),
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
  ];
  return `  ${smoke.id.padEnd(34)} ${smoke.title}\n${' '.repeat(36)} ${flags.join(' · ')}`;
}

/** Run one smoke with a wall clock. Never throws; returns a result record. */
async function runOneSmoke(smoke, { session, cfg, nonce, log, timeoutMs, controllers }) {
  const controller = new AbortController();
  controllers.add(controller);
  const started = Date.now();

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
    log.ok(`${smoke.id} (${Date.now() - started} ms)`);
    return { smoke, status: 'passed', ms: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.fail(`${smoke.id}: ${clip(message, 800)}`);
    return { smoke, status: 'failed', ms: Date.now() - started, error: message };
  } finally {
    clearTimeout(timer);
    controllers.delete(controller);
  }
}

function printSummary({ log, results, skipped, startSweep, endSweep, nonce, keep }) {
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed');
  const leaked = [...(startSweep?.leaked ?? []), ...(endSweep?.leaked ?? [])];
  const swept = (startSweep?.deleted.length ?? 0) + (endSweep?.deleted.length ?? 0);

  log.line('');
  log.line('Summary');
  log.info(
    `smokes   ${passed} passed, ${failed.length} failed, ${skipped.length} skipped (budget/selection)`,
  );
  log.info(`sweep    ${swept} artifact(s) deleted, ${leaked.length} left behind`);
  log.info(`marker   ${markerFor(nonce)}`);
  for (const result of failed) {
    log.fail(`${result.smoke.id}: ${clip(result.error ?? 'failed', 300)}`);
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
  const ok = failed.length === 0 && leaked.length === 0;
  log.info(`result   ${ok ? 'PASS' : 'FAIL'}`);
  return ok ? EXIT.ok : EXIT.failed;
}

async function main() {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
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

  try {
    if (cfg.sweepEnabled) {
      startSweep = await runSweep({ phase: 'start', session, pages, nonce, log });
    }
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
    nonce,
    keep: args.keep,
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

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(
      `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = EXIT.failed;
  },
);
