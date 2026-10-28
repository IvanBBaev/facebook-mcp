// Doctor probes for the `insights` lane: the injected metric probe (V02 seam)
// and the live metric-set probe (C6 / CC-INS-1).

import {
  GraphApiError,
  createPagesRegistry,
  errorMessageOf,
  type ParamValue,
  type Settings,
} from '../../core/index.js';
import { UNANSWERED_SKIP_REASON, runProbe } from './probes.js';
import {
  type DoctorDeps,
  type DoctorTokenReport,
  type MetricProbeReport,
  type ProbedMetric,
  type MetricSetReport,
  type MetricSetVerdict,
  type MetricVerdictStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// Insights metric set (C6 / CC-INS-1) — what the probe asks the live API about
// ---------------------------------------------------------------------------

/**
 * The Page metric set the server documents and the doctor verifies.
 *
 * Keep this list, the api layer's deprecation table and the README metric table
 * in step — that is exactly the drift this probe exists to catch.
 */
export const PROBED_PAGE_METRICS: readonly ProbedMetric[] = [
  { metric: 'page_media_view', replaces: ['page_impressions'] },
  { metric: 'page_post_engagements', replaces: ['page_engaged_users'] },
  { metric: 'page_follows', replaces: ['page_fans'] },
  { metric: 'page_daily_follows', replaces: ['page_fan_adds'] },
  { metric: 'page_daily_follows_unique', replaces: ['page_fan_adds_unique'] },
  {
    metric: 'page_daily_unfollows',
    replaces: ['page_fan_removes'],
    note: "not listed in Meta's current metric reference (only page_daily_unfollows_unique is); if Graph rejects it, point page_fan_removes at page_daily_unfollows_unique",
  },
  { metric: 'page_daily_unfollows_unique', replaces: ['page_fan_removes_unique'] },
  { metric: 'page_total_media_view_unique', replaces: ['page_impressions_unique'] },
  {
    metric: 'page_video_views',
    note: 'the *_unique variant was retired with no deduplicated replacement',
  },
];

/**
 * The probe asks for one period only. `day` is what the api layer defaults to
 * for Page scope, so this measures the metric set as callers actually meet it.
 */
export const METRIC_PROBE_PERIOD = 'day';

/** A health check, not a data pull: three days is enough to prove a name lives. */
export const METRIC_PROBE_WINDOW_DAYS = 3;

/** Graph refuses Page-insights windows wider than this; we stay far inside it. */
export const METRIC_PROBE_MAX_WINDOW_DAYS = 90;

/**
 * Below roughly this many likes/followers a Page is not eligible for insights and
 * Graph answers every metric with an empty series (CC-INS-2). Mirrors the api
 * layer's constant of the same meaning; a test asserts the two agree.
 */
export const METRIC_PROBE_LIKES_FLOOR = 100;

// ---------------------------------------------------------------------------
// Insights metric-set probe (C6 / CC-INS-1)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` in UTC — the form Graph accepts for `since` / `until`. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The Page the probe runs against, and where that Page came from. */
interface ProbeTarget {
  readonly pageId: string;
  readonly source: string;
  /** The profile key when the Page came from a profile; absent ⇒ the default Page. */
  readonly profile?: string;
}

/**
 * Pick a Page to probe WITHOUT calling Graph: the default Page if configured,
 * otherwise the alphabetically first profile. Deterministic on purpose — a
 * health check that probes a different Page on every run is not a health check.
 */
function resolveProbePage(settings: Settings): ProbeTarget | undefined {
  const direct = settings.defaultPageId?.trim();
  if (direct !== undefined && direct !== '') {
    return { pageId: direct, source: 'FB_PAGE_ID' };
  }
  const named = Object.entries(settings.profiles)
    .map(([name, profile]) => [name, profile.pageId.trim()] as const)
    .filter(([, pageId]) => pageId !== '')
    .sort(([a], [b]) => a.localeCompare(b))[0];
  if (named === undefined) return undefined;
  return { pageId: named[1], source: `profile "${named[0]}"`, profile: named[0] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Count the non-null data points Graph returned per metric name.
 *
 * A name ABSENT from the map was never mentioned in the response — that is the
 * silent failure this whole check exists to expose. A name present with 0 is a
 * live metric with nothing to say.
 */
function readMetricPoints(body: unknown): Map<string, number> {
  const points = new Map<string, number>();
  const rows: readonly unknown[] =
    isRecord(body) && Array.isArray(body.data) ? body.data : [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const name = row.name;
    if (typeof name !== 'string') continue;
    const values: readonly unknown[] = Array.isArray(row.values) ? row.values : [];
    const filled = values.filter(
      (point) => isRecord(point) && point.value !== null && point.value !== undefined,
    ).length;
    points.set(name, (points.get(name) ?? 0) + filled);
  }
  return points;
}

/**
 * The Page token the insights tools would read this Page with.
 *
 * A Page insights edge wants a Page access token; sent bare, the transport
 * falls back to FB_SYSTEM_TOKEN / FB_ACCESS_TOKEN and Graph either refuses the
 * call or answers it empty (CC-AUTH-2), so the probe would condemn a metric set
 * the tools read fine. Resolved through the same registry the tools use: a
 * profile's own token verbatim, FB_PAGE_TOKEN for the default Page when there
 * is no base token, otherwise one derivation from the base token. The registry
 * registers every token it hands out with the redactor.
 */
async function resolveProbeToken(deps: DoctorDeps, target: ProbeTarget): Promise<string> {
  const registry = createPagesRegistry({
    settings: deps.settings,
    fbRequest: deps.fbRequest,
    clock: deps.clock,
    redactor: deps.redactor,
  });
  const resolved = await registry.resolvePage(target.profile);
  return resolved.token;
}

/** One insights read through the injected client, under the probed Page's token. */
async function requestMetricWindow(
  deps: DoctorDeps,
  pageId: string,
  pageToken: string,
  metrics: readonly string[],
  since: string,
  until: string,
): Promise<unknown> {
  const params: Record<string, ParamValue> = {
    metric: metrics.join(','),
    period: METRIC_PROBE_PERIOD,
    since,
    until,
  };
  const res = await deps.fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: `/${pageId}/insights`,
    params,
    token: pageToken,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });
  return res.data;
}

/**
 * Did Graph refuse a METRIC NAME, as opposed to the call as a whole?
 *
 * Meta reports a dead metric as a generic `#100` (or `#3001`) whose message
 * names the metric, so the message is the only discriminator available. Same
 * heuristic the api layer uses.
 */
function isMetricRejection(err: unknown): err is GraphApiError {
  return (
    err instanceof GraphApiError &&
    (err.code === 100 || err.code === 3001) &&
    /metric/i.test(err.message)
  );
}

/** Graph's own words, redacted, plus its operator guidance when the taxonomy has any. */
function describeGraphFailure(deps: DoctorDeps, err: unknown): string {
  const message = deps.redactor.redactString(errorMessageOf(err));
  if (!(err instanceof GraphApiError)) return message;
  const subcode = err.subcode !== undefined ? `/${String(err.subcode)}` : '';
  // Meta usually opens its own message with "(#code)". Repeating it reads like a
  // bug, so the prefix is added only when Graph left it out (the subcode rides
  // along with it — Meta's self-labelled messages do not carry one).
  const head = message.includes(`#${String(err.code)}`)
    ? message
    : `(#${String(err.code)}${subcode}) ${message}`;
  const operatorText = err.action?.operatorText;
  return operatorText !== undefined ? `${head} — ${operatorText}` : head;
}

function replacesOf(entry: ProbedMetric): { replaces?: readonly string[] } {
  return entry.replaces !== undefined && entry.replaces.length > 0
    ? { replaces: entry.replaces }
    : {};
}

/** What to tell the operator when Graph refuses a name this server ships. */
function driftSuggestion(entry: ProbedMetric): string {
  const lineage =
    entry.replaces !== undefined && entry.replaces.length > 0
      ? ` It is this server's replacement for ${entry.replaces.join(', ')}, so that rename wave has moved on again — search Meta's Graph API changelog for the old name to find the current one.`
      : " Search Meta's Graph API changelog for this name to find its replacement.";
  return `Meta no longer accepts "${entry.metric}".${lineage} Then update PROBED_PAGE_METRICS and the README metric table.`;
}

/**
 * Graph answered, but never mentioned this metric.
 *
 * An absent entry has two causes Graph does not tell apart: a name that is not
 * valid for this Page or API version, and a live metric that does not serve the
 * probed period (Graph omits an unsupported metric/period pair rather than
 * failing the call — the api layer documents the same). Asserting the first
 * sent the operator to drop a name that may be perfectly current.
 */
function silentSuggestion(metric: string, apiVersion: string): string {
  return `Graph answered without a "${metric}" entry. Graph omits a name that is not valid for this Page or for ${apiVersion}, and equally a metric that does not serve period="${METRIC_PROBE_PERIOD}" — the probe cannot tell which. This is NOT the same as a valid metric with no data: check the name and its supported periods in Meta's metric reference for ${apiVersion} before changing PROBED_PAGE_METRICS.`;
}

function classifyPoints(
  entry: ProbedMetric,
  points: number | undefined,
  apiVersion: string,
): MetricSetVerdict {
  if (points === undefined) {
    return {
      metric: entry.metric,
      status: 'unknown',
      ...replacesOf(entry),
      suggestion: silentSuggestion(entry.metric, apiVersion),
    };
  }
  return {
    metric: entry.metric,
    status: points > 0 ? 'accepted' : 'empty',
    points,
    ...replacesOf(entry),
  };
}

/**
 * Fallback when the batched call died on a metric name: ask each name ALONE, so
 * one dead metric cannot hide the health of the other seven.
 *
 * Strictly bounded — every metric is asked at most once and a rejected metric is
 * never retried, so the whole check costs at most `1 + metrics.length` calls. A
 * non-metric failure (auth, rate limit, outage) stops the pass immediately: the
 * remaining names stay `unknown` with the reason attached rather than pounding a
 * Graph edge that has already said no.
 */
async function isolateMetrics(
  deps: DoctorDeps,
  pageId: string,
  pageToken: string,
  metrics: readonly ProbedMetric[],
  since: string,
  until: string,
): Promise<{ requests: number; verdicts: MetricSetVerdict[]; notProbed: number }> {
  const verdicts: MetricSetVerdict[] = [];
  // The batched attempt is already spent; count it.
  let requests = 1;
  let halted: string | undefined;
  // Names Graph never ruled on because the pass failed or stopped: `unknown`
  // like a silent omission, but they say nothing about the metric set.
  let notProbed = 0;

  for (const entry of metrics) {
    if (halted !== undefined) {
      notProbed += 1;
      verdicts.push({
        metric: entry.metric,
        status: 'unknown',
        ...replacesOf(entry),
        suggestion: `Not probed — the isolation pass stopped earlier: ${halted}`,
      });
      continue;
    }
    requests += 1;
    try {
      const body = await requestMetricWindow(
        deps,
        pageId,
        pageToken,
        [entry.metric],
        since,
        until,
      );
      verdicts.push(
        classifyPoints(
          entry,
          readMetricPoints(body).get(entry.metric),
          deps.settings.apiVersion,
        ),
      );
    } catch (err) {
      const reason = describeGraphFailure(deps, err);
      if (isMetricRejection(err)) {
        verdicts.push({
          metric: entry.metric,
          status: 'rejected',
          ...replacesOf(entry),
          error: reason,
          suggestion: driftSuggestion(entry),
        });
        continue;
      }
      halted = reason;
      notProbed += 1;
      verdicts.push({
        metric: entry.metric,
        status: 'unknown',
        ...replacesOf(entry),
        suggestion: `Not probed — ${reason}`,
      });
    }
  }
  return { requests, verdicts, notProbed };
}

function countStatus(
  verdicts: readonly MetricSetVerdict[],
  status: MetricVerdictStatus,
): number {
  return verdicts.filter((verdict) => verdict.status === status).length;
}

/** Caveats the numbers alone would mislead the operator about. */
function metricSetNotes(
  verdicts: readonly MetricSetVerdict[],
  isolated: boolean,
  notProbed = 0,
): string[] {
  const notes: string[] = [];
  if (isolated) {
    notes.push(
      'Graph rejected the batched request because of a metric name, so every name was re-asked on its own. One dead name fails the whole call, which is why a single rename reads as "insights are broken".',
    );
  }
  if (countStatus(verdicts, 'empty') > 0) {
    notes.push(
      `An empty series is DATA, not a failure: Graph accepted the name and had nothing to report. A Page below roughly ${String(METRIC_PROBE_LIKES_FLOOR)} likes/followers is not eligible for insights and legitimately returns nothing for every metric, and a genuinely quiet ${String(METRIC_PROBE_WINDOW_DAYS)}-day window looks identical.`,
    );
  }
  if (countStatus(verdicts, 'empty') + countStatus(verdicts, 'unknown') - notProbed > 0) {
    notes.push(
      `The probe asks for period="${METRIC_PROBE_PERIOD}" only. A metric that exists but does not support daily buckets is left out of Graph's answer altogether, so it reads as unknown above — not as empty.`,
    );
  }
  // A name the pass never got an answer for is `unknown` too, but counting it
  // here told the operator to edit a metric list Graph was never asked about —
  // after a rate limit, that is every name behind the throttled one.
  const broken =
    countStatus(verdicts, 'rejected') + countStatus(verdicts, 'unknown') - notProbed;
  if (broken > 0) {
    notes.push(
      `ACTION: ${String(broken)} of ${String(verdicts.length)} shipped metric name(s) did not check out against the live API. Fix PROBED_PAGE_METRICS and re-generate the README metric table before trusting any insights output.`,
    );
  }
  if (notProbed > 0) {
    notes.push(
      `${String(notProbed)} of ${String(verdicts.length)} shipped metric name(s) were not probed — the isolation pass stopped on a failure that is not about metric names (see their lines). They say nothing about the metric set; fix that failure and re-run the doctor.`,
    );
  }
  if (broken === 0 && notProbed === 0) {
    notes.push(
      'Every shipped metric name is still accepted by this API version — the documented metric set is current.',
    );
  }
  notes.push(
    'Today\'s bucket is still being computed, so a missing or zero point at the end of the window means "not aggregated yet", not "no activity".',
  );
  return notes;
}

function skippedMetricSet(reason: string): MetricSetReport {
  return {
    outcome: 'skipped',
    summary: `metric set: skipped (${reason})`,
    requests: 0,
    verdicts: [],
    notes: [],
  };
}

/**
 * Ask the live API whether the metric set this server documents still exists
 * (C6 / CC-INS-1).
 *
 * One batched call in the happy path; a bounded per-metric pass only when Graph
 * refuses a name. Skipped — never failed — when a prerequisite is missing, so
 * the doctor still reports everything else it learned.
 */
export async function probeMetricSet(
  deps: DoctorDeps,
  token: DoctorTokenReport,
  now: number,
): Promise<MetricSetReport> {
  const metrics = deps.metricSet ?? PROBED_PAGE_METRICS;
  if (!token.configured) {
    return skippedMetricSet(
      'no token configured — set FB_SYSTEM_TOKEN (or FB_ACCESS_TOKEN / FB_PAGE_TOKEN) and re-run',
    );
  }
  if (!token.valid) {
    return skippedMetricSet(
      token.diagnosis === 'token_check_failed'
        ? UNANSWERED_SKIP_REASON
        : 'the configured token did not check out (see Token above) — probing metric names with a dead token proves nothing',
    );
  }
  if (metrics.length === 0) {
    return skippedMetricSet('the metric set is empty — nothing to verify');
  }
  const target = resolveProbePage(deps.settings);
  if (target === undefined) {
    return skippedMetricSet(
      'no Page configured — set FB_PAGE_ID or a profile Page, then re-run (the doctor probes the configured Page, it does not go shopping for one)',
    );
  }

  const until = utcDay(now);
  const since = utcDay(now - (METRIC_PROBE_WINDOW_DAYS - 1) * MS_PER_DAY);
  const names = metrics.map((entry) => entry.metric);
  const window = { pageId: target.pageId, period: METRIC_PROBE_PERIOD, since, until };

  let pageToken: string;
  try {
    pageToken = await resolveProbeToken(deps, target);
  } catch (err) {
    return {
      outcome: 'failed',
      summary: `metric set: probe failed (could not obtain a Page token for Page ${target.pageId}: ${describeGraphFailure(deps, err)})`,
      ...window,
      requests: 0,
      verdicts: [],
      notes: [
        'No insights call was made, so this says nothing about whether the metric names are still valid — fix the error above and re-run the doctor.',
      ],
    };
  }

  let requests = 1;
  let verdicts: readonly MetricSetVerdict[];
  let isolated = false;
  let notProbed = 0;
  try {
    const body = await requestMetricWindow(
      deps,
      target.pageId,
      pageToken,
      names,
      since,
      until,
    );
    const points = readMetricPoints(body);
    verdicts = metrics.map((entry) =>
      classifyPoints(entry, points.get(entry.metric), deps.settings.apiVersion),
    );
  } catch (err) {
    if (!isMetricRejection(err)) {
      return {
        outcome: 'failed',
        summary: `metric set: probe failed (${describeGraphFailure(deps, err)})`,
        ...window,
        requests,
        verdicts: [],
        notes: [
          'The call never reached the metric names, so this says nothing about whether they are still valid — fix the error above and re-run the doctor.',
        ],
      };
    }
    isolated = true;
    const pass = await isolateMetrics(
      deps,
      target.pageId,
      pageToken,
      metrics,
      since,
      until,
    );
    requests = pass.requests;
    verdicts = pass.verdicts;
    notProbed = pass.notProbed;
  }

  const summary =
    `metric set: ${String(countStatus(verdicts, 'accepted'))} accepted, ` +
    `${String(countStatus(verdicts, 'empty'))} empty, ` +
    `${String(countStatus(verdicts, 'rejected'))} rejected, ` +
    `${String(countStatus(verdicts, 'unknown'))} unknown ` +
    `of ${String(verdicts.length)} on Page ${target.pageId} (${target.source}), ` +
    `period=${METRIC_PROBE_PERIOD} ${since}..${until}, ${String(requests)} request(s)`;

  return {
    outcome: 'probed',
    summary,
    ...window,
    requests,
    verdicts,
    notes: metricSetNotes(verdicts, isolated, notProbed),
  };
}

/**
 * The injected insights metric probe (V02 seam), folded into the report.
 *
 * Without a credential the probe can only fail on the missing token (or the
 * missing Page), and that failure used to land in the verdict as a second,
 * UNKNOWN line next to the token FAIL that already names the one fix. A
 * first-time operator saw two problems where there is one, so skip it — the
 * same call the metric-set probe makes.
 *
 * A token check that never got an answer (network fault, 5xx, throttle) is the
 * same kind of dead end: every dependent probe goes over the same broken
 * connection, and each one's retry budget added seconds of silence (~9 s
 * offline) only to print the failure the Token block already names.
 */
export async function insightsMetricProbe(
  deps: DoctorDeps,
  token: DoctorTokenReport,
): Promise<MetricProbeReport> {
  if (!token.configured) {
    return {
      available: false,
      summary: 'metric probe: skipped (no token configured — see Token above)',
    };
  }
  if (token.diagnosis === 'token_check_failed') {
    return {
      available: false,
      summary: `metric probe: skipped (${UNANSWERED_SKIP_REASON})`,
    };
  }
  return runProbe(
    deps,
    deps.metricProbe,
    'metric probe',
    'metric probe: unavailable (no insights probe wired — enable the insights package to surface Page/Post reach diagnostics).',
  );
}
