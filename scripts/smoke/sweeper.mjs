// The sweep orchestrator (CC-LIFE-3).
//
// The harness runs a sweep TWICE per run:
//
//   * start sweep — before the first smoke. Deletes leftovers from an earlier
//     run that crashed, was killed, or lost its network halfway. Without this,
//     a single bad run would poison the test Page forever.
//   * end sweep — after the last smoke, in a `finally`, so it also runs when a
//     smoke throws, when a smoke times out and when the operator hits Ctrl-C.
//
// The sweep is marker-driven, not ledger-driven: it re-reads the test Page and
// deletes everything carrying `[FBMCP-SMOKE …]`, including markers from OTHER
// runs. That is the property that makes cleanup survive a crash — a ledger held
// in the crashed process's memory would not.
//
// Nothing here throws. An artifact that could not be deleted is a REPORTED
// leak, not a swallowed error and not an exception that would skip the
// remaining sweepers: the run then exits non-zero with the artifact's id and
// the reason, so a human can finish the job by hand.

import { unwrapTainted } from './client.mjs';
import { listSweepers } from './registry.mjs';
import { findMarkerNonce, isMarked, MARKER_RE } from './nonce.mjs';

/** Upper bound on deletions per sweep — a runaway loop must not eat a Page. */
export const SWEEP_DELETE_CAP = 100;

/** The one command that cleans the test Page without running any smoke. */
const SWEEP_ONLY_HINT = 'FB_SMOKE=1 npm run smoke -- --sweep-only';

/**
 * Report a sweep that could not run AT ALL, and return a report in the shape
 * `runSweep` produces so the summary can still account for it.
 *
 * Every sweep is a sequence of tool calls, so it needs a live server session. If
 * the session never came up — or died — the honest answer is not "nothing was
 * found", it is "nothing was looked at". Saying that out loud is the whole point
 * of this function: silence here reads as a clean Page.
 *
 * @param {object} opts
 * @param {'start'|'end'} opts.phase
 * @param {string} opts.reason  why there is no session
 * @param {string} opts.consequence  what is therefore still on the test Page
 * @param {ReturnType<import('./log.mjs').createLogger>} opts.log
 */
export function sweepUnavailable({ phase, reason, consequence, log }) {
  log.fail(
    `${phase} sweep SKIPPED (${reason}) — ${consequence} Clean the test Page with:  ${SWEEP_ONLY_HINT}`,
  );
  return { phase, items: [], deleted: [], leaked: [], skipped: true };
}

function describe(item) {
  const age = item.nonce === undefined ? 'unmarked' : item.nonce;
  return `${item.kind} ${item.id} (${age})${item.label === undefined ? '' : ` — ${item.label}`}`;
}

/**
 * Run every registered sweeper once. Never throws.
 *
 * @param {object} opts
 * @param {'start'|'end'} opts.phase
 * @param {object} opts.session  the object returned by `startSmokeClient`
 * @param {{testProfile: string, testPageId: string}} opts.pages
 * @param {string} opts.nonce
 * @param {ReturnType<import('./log.mjs').createLogger>} opts.log
 * @returns {Promise<{phase: string, items: object[], deleted: object[], leaked: object[]}>}
 */
export async function runSweep({ phase, session, pages, nonce, log }) {
  const sweepers = listSweepers();
  const items = [];

  if (sweepers.length === 0) {
    log.skip(`${phase} sweep: no sweepers registered`);
    return { phase, items, deleted: [], leaked: [] };
  }

  for (const sweeper of sweepers) {
    const ctx = {
      nonce,
      pages,
      markerRe: MARKER_RE,
      isMarked,
      findMarkerNonce,
      unwrap: unwrapTainted,
      deleteCap: SWEEP_DELETE_CAP,
      log,
      callTool: session.callTool,
      callToolRaw: session.callToolRaw,
      applyWrite: session.applyWrite,
    };
    try {
      const produced = (await sweeper.sweep(ctx)) ?? [];
      for (const item of produced) {
        items.push({ sweeper: sweeper.id, ...item });
      }
    } catch (err) {
      // A sweeper that blew up may well have left artifacts behind, and we
      // cannot know which — say so instead of pretending the Page is clean.
      items.push({
        sweeper: sweeper.id,
        kind: 'sweeper',
        id: sweeper.id,
        deleted: false,
        reason: `sweeper threw: ${err instanceof Error ? err.message : String(err)}`,
        label: 'the test Page may still hold artifacts this sweeper owns',
      });
    }
  }

  const deleted = items.filter((item) => item.deleted === true);
  const leaked = items.filter((item) => item.deleted !== true);

  if (items.length === 0) {
    log.ok(`${phase} sweep: nothing marked on the test Page`);
  } else {
    log.info(`${phase} sweep: ${deleted.length} deleted, ${leaked.length} left behind`);
    for (const item of deleted) {
      log.step(`deleted ${describe(item)}`);
    }
    for (const item of leaked) {
      log.fail(`COULD NOT DELETE ${describe(item)}: ${item.reason ?? 'unknown reason'}`);
    }
  }

  return { phase, items, deleted, leaked };
}

/**
 * The end sweep, wrapped so that no failure inside it can mask the result of
 * the run itself. Returns a report even when the session is unusable.
 */
export async function runEndSweep({ session, pages, nonce, log, reason }) {
  if (session === undefined) {
    return sweepUnavailable({
      phase: 'end',
      reason,
      consequence: "any artifact marked with this run's nonce is still on the test Page.",
      log,
    });
  }
  try {
    return await runSweep({ phase: 'end', session, pages, nonce, log });
  } catch (err) {
    log.fail(
      `end sweep FAILED: ${err instanceof Error ? err.message : String(err)} — re-run with --sweep-only`,
    );
    return { phase: 'end', items: [], deleted: [], leaked: [], skipped: true };
  }
}
