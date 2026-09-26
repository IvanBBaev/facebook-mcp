// Which tools a live run actually exercised — the denominator the summary was
// missing.
//
// The harness exists to produce evidence that the SHIPPED server works against
// the real Graph API, and its summary counted smokes: "8 passed" reads as a
// verified surface. It is not one. A smoke is a scenario, not a tool, and
// nothing in the run knew — or said — that a tool the server advertised to this
// very session was never called once. `--phase 2` could go green having never
// touched half the tools that phase ships, and the line an operator quotes when
// they open the 1.0 gate would be true and still mean far less than it looks.
//
// So the runner records every tool the server ANSWERED (`client.mjs`) and asks
// the session what it advertised, and this module does the set arithmetic. Both
// halves are facts about the run rather than declarations a smoke author could
// forget to update: a coverage table maintained by hand drifts, and it drifts
// silently in the optimistic direction.
//
// Pure and side-effect free on purpose — it is the one part of the harness that
// can be pinned by a hermetic test (`src/smoke-harness.test.ts`) without a
// token, a socket or a live Page.

/**
 * Compare what the session advertised against what it answered.
 *
 * @param {{ advertised: readonly string[], called: readonly string[] }} input
 * @returns {{ total: number, exercised: string[], uncovered: string[], unadvertised: string[] }}
 *
 * `unadvertised` is not padding. A name the run called but the server never
 * listed means the harness is calling a tool this package selection does not
 * load — a renamed tool, or a smoke registered under the wrong `packages` — and
 * every such call comes back as "unknown tool", which several smokes would
 * otherwise absorb as an ordinary tool error.
 */
export function toolCoverage({ advertised = [], called = [] } = {}) {
  const advertisedSet = new Set(advertised);
  const calledSet = new Set(called);
  const exercised = [];
  const uncovered = [];
  for (const name of [...advertisedSet].sort()) {
    (calledSet.has(name) ? exercised : uncovered).push(name);
  }
  const unadvertised = [...calledSet].filter((name) => !advertisedSet.has(name)).sort();
  return { total: advertisedSet.size, exercised, uncovered, unadvertised };
}

/** How many uncovered names the summary prints before it stops listing them. */
const NAMED_UNCOVERED_LIMIT = 12;

/**
 * The `tools` line of the summary. It names the tools that went untouched
 * rather than only counting them: an operator reading this is deciding whether
 * the gap is the selection they asked for or a smoke that quietly stopped
 * calling something, and a bare "24/31" cannot tell them apart.
 */
export function formatCoverageLine(coverage) {
  if (coverage.total === 0) {
    return 'no tools were advertised to this session, so nothing could be exercised';
  }
  const head = `${coverage.exercised.length} of ${coverage.total} advertised tool(s) exercised`;
  if (coverage.uncovered.length === 0) {
    return `${head} — every advertised tool was called`;
  }
  const shown = coverage.uncovered.slice(0, NAMED_UNCOVERED_LIMIT);
  const rest = coverage.uncovered.length - shown.length;
  const names = rest > 0 ? `${shown.join(', ')}, +${rest} more` : shown.join(', ');
  return `${head} — never called: ${names}`;
}
